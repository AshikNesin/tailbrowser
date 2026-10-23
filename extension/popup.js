// tailbrowser popup: connection status, sharing the current tab, scope and
// relay settings. Status live-refreshes every 2s; a form field is only synced
// from the extension while the user isn't editing it, so a refresh never
// overwrites what they are typing.

const $ = (id) => document.getElementById(id);

const STATE_LABELS = { setup: 'Not set up', connecting: 'Connecting…', connected: 'Connected', revoked: 'Revoked' };
const SCOPE_HELP = {
  tab: 'Agents see only the tabs you share from this popup.',
  allowlist: 'Agents see tabs whose URL matches a pattern, attached automatically as you browse.',
  full: 'Agents see every tab and can open and close tabs.',
};
const EMPTY_SHARED = {
  tab: 'Nothing shared yet. Use “Share with agents” above.',
  allowlist: 'No open tab matches the allowlist.',
  full: 'Waiting for the relay. Tabs are shared once connected.',
};

let status = null;
let currentTab = null;
let firstRender = true;
let actionError = null; // { text, until }; errors from button clicks outrank the background's lastError

function call(t, extra = {}) {
  return chrome.runtime.sendMessage({ t, ...extra })
    .then((r) => r ?? { ok: false, error: 'extension did not answer; try reopening the popup' })
    .catch((e) => ({ ok: false, error: String(e.message || e) }));
}

// run a button action: disable while busy, surface failures, refresh after
async function act(button, fn) {
  button.disabled = true;
  try {
    const r = await fn();
    actionError = r && r.ok === false ? { text: r.error, until: Date.now() + 8000 } : null;
  } finally {
    button.disabled = false;
  }
  await refresh();
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host ? u.host + (u.pathname === '/' ? '' : u.pathname) : url;
  } catch { return url || ''; }
}

function setFavicon(img, url) {
  if (url && /^(https?|data):/.test(url)) img.src = url;
  else img.removeAttribute('src');
}

function ago(ms) {
  if (ms == null) return 'never';
  return ms < 1500 ? 'just now' : `${Math.round(ms / 1000)}s ago`;
}

// ---------- rendering ----------

function renderHeader() {
  const { state } = status;
  $('statePill').dataset.state = state;
  $('statePill').textContent = STATE_LABELS[state] || state;

  const ka = status.keepalive || {};
  $('subline').textContent = {
    setup: 'Enter your relay URL below to get started.',
    revoked: 'Agent access revoked. Nothing is shared.',
    connecting: `Trying ${status.relay}…`,
    connected: `${status.relay} · keep-alive ${ka.port ? '✓' : 'starting…'} · heard ${ago(ka.lastHeardAgoMs)}`,
  }[state] || '';

  const notice = $('notice');
  const err = actionError && actionError.until > Date.now() ? actionError.text : null;
  const text = err || (state === 'connecting' ? status.lastError : null);
  notice.textContent = text || '';
  notice.classList.toggle('info', !err);
  notice.classList.toggle('hidden', !text);
}

function renderCurrentTab() {
  const section = $('currentSection');
  section.classList.toggle('hidden', !currentTab || status.state === 'setup');
  if (!currentTab) return;

  const shared = status.attached.some((t) => t.tabId === currentTab.id);
  setFavicon($('currentIcon'), currentTab.favIconUrl);
  $('currentTitle').textContent = currentTab.title || 'Untitled tab';
  $('currentUrl').textContent = shortUrl(currentTab.url);
  $('currentBadge').textContent = shared ? 'Shared' : 'Not shared';
  $('currentBadge').classList.toggle('on', shared);

  const button = $('currentAction');
  const blocked = status.state === 'setup' || status.state === 'revoked';
  button.disabled = blocked;
  button.textContent = shared ? 'Stop sharing' : 'Share with agents';
  button.classList.toggle('primary', !shared);

  const hint = $('currentHint');
  hint.textContent = blocked
    ? 'Reconnect the agent to share tabs again.'
    : shared ? 'Chrome shows a “debugging this browser” banner while a tab is shared. Dismissing it stops sharing.' : '';
  hint.classList.toggle('hidden', !hint.textContent);
}

function renderScope() {
  for (const button of document.querySelectorAll('[data-scope]')) {
    button.setAttribute('aria-pressed', String(button.dataset.scope === status.scopeMode));
  }
  $('scopeHelp').textContent = SCOPE_HELP[status.scopeMode] || '';
  $('allowlistBox').classList.toggle('hidden', status.scopeMode !== 'allowlist');
}

function renderSharedTabs() {
  $('sharedSection').classList.toggle('hidden', status.state === 'setup');
  const box = $('sharedTabs');
  const tabs = status.attached;
  $('sharedCount').textContent = tabs.length ? `· ${tabs.length}` : '';
  box.replaceChildren();
  if (!tabs.length) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.textContent = status.state === 'revoked'
      ? 'Nothing is shared while access is revoked.'
      : EMPTY_SHARED[status.scopeMode] || '';
    box.append(empty);
    return;
  }
  for (const tab of tabs) {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const icon = document.createElement('img');
    icon.className = 'favicon';
    icon.alt = '';
    setFavicon(icon, tab.favIconUrl);

    const text = document.createElement('div');
    text.className = 'tab-text';
    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || `Tab ${tab.tabId}`;
    const url = document.createElement('div');
    url.className = 'tab-url';
    url.textContent = shortUrl(tab.url);
    text.append(title, url);

    const stop = document.createElement('button');
    stop.className = 'btn small-btn';
    stop.textContent = 'Stop';
    stop.title = 'Stop sharing this tab';
    stop.onclick = () => act(stop, () => call('optOut', { tabId: tab.tabId }));

    row.append(icon, text, stop);
    box.append(row);
  }
}

function renderSettings() {
  $('clearToken').classList.toggle('hidden', !status.hasToken);
  $('token').placeholder = status.hasToken
    ? 'Saved. Leave blank to keep it.'
    : 'Optional; leave blank if the relay is tokenless';

  const revoke = $('revoke');
  revoke.classList.toggle('hidden', status.state === 'setup');
  revoke.textContent = status.state === 'revoked' ? 'Reconnect agent' : 'Disconnect agent (revoke access)';
  revoke.classList.toggle('danger', status.state !== 'revoked');
  revoke.classList.toggle('primary', status.state === 'revoked');

  syncField($('relay'), status.relay || '');
  syncField($('allowlist'), (status.allowlist || []).join('\n'));
  if (firstRender) $('relaySettings').open = status.state === 'setup';
  firstRender = false;
}

// fields the user is editing (focused, or changed and not yet saved) are left alone
function syncField(el, value) {
  if (document.activeElement === el || el.dataset.dirty) return;
  el.value = value;
}

for (const el of [$('relay'), $('allowlist')]) {
  el.addEventListener('input', () => { el.dataset.dirty = '1'; });
}

function render() {
  status.attached ||= [];
  renderHeader();
  renderCurrentTab();
  renderScope();
  renderSharedTabs();
  renderSettings();
}

async function refresh() {
  const [next, [tab]] = await Promise.all([
    call('getStatus'),
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
  ]);
  if (next && next.state) status = next;
  currentTab = tab || null;
  if (status) render();
}

// ---------- actions ----------

$('currentAction').onclick = () => {
  if (!currentTab) return;
  const shared = status.attached.some((t) => t.tabId === currentTab.id);
  act($('currentAction'), () => call(shared ? 'optOut' : 'optIn', { tabId: currentTab.id }));
};

for (const button of document.querySelectorAll('[data-scope]')) {
  button.onclick = () => {
    const scopeMode = button.dataset.scope;
    if (scopeMode === status.scopeMode) return;
    if (scopeMode === 'full' && !confirm('Give agents access to every tab in this browser, including opening and closing tabs?')) return;
    act(button, () => call('setScope', { scopeMode }));
  };
}

$('saveAllowlist').onclick = () => {
  const allowlist = $('allowlist').value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  act($('saveAllowlist'), async () => {
    const r = await call('setScope', { allowlist });
    if (r.ok) delete $('allowlist').dataset.dirty;
    return r;
  });
};

$('save').onclick = () => {
  const token = $('token').value.trim();
  const opts = { relay: $('relay').value.trim(), token: token || undefined }; // blank keeps the saved token
  act($('save'), async () => {
    const r = await call('saveOpts', { opts });
    if (r.ok) {
      $('token').value = '';
      delete $('relay').dataset.dirty;
    }
    return r;
  });
};

$('clearToken').onclick = () => act($('clearToken'), () => call('saveOpts', { opts: { token: '' } }));

$('discover').onclick = () => {
  const button = $('discover');
  const label = button.textContent;
  button.textContent = 'Searching…';
  act(button, async () => {
    const r = await call('discover');
    button.textContent = label;
    if (r.ok) delete $('relay').dataset.dirty;
    return r;
  });
};

$('revoke').onclick = () => {
  const reconnecting = status.state === 'revoked';
  act($('revoke'), () => call(reconnecting ? 'reconnect' : 'disconnectAgent'));
};

refresh();
setInterval(refresh, 2000); // watch it come up while the popup is open
