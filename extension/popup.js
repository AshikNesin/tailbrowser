// tailbrowser M0 popup
const $ = (id) => document.getElementById(id);

function render(status) {
  const configured = status.configured === true;
  const unconfigured = !configured;
  $('status').textContent = unconfigured ? 'Not configured — enter relay URL, then Save'
    : status.connected ? (status.keepalive && status.keepalive.offscreen
        ? 'Connected — background keep-alive active'
        : 'Connected (starting keep-alive…)')
    : 'Connecting / relay unreachable…';
  if (status.keepalive) {
    const ka = status.keepalive;
    $('keepalive').textContent = `keep-alive: ${ka.offscreen ? 'port ✓' : 'port ✗'} · last relay pong ${ka.lastPongAgoMs != null ? Math.round(ka.lastPongAgoMs / 1000) + 's ago' : '—'}`;
  }
  $('status').className = status.connected ? 'ok' : 'bad';
  $('relay').value = status.relay || '';
  if (!unconfigured) $('token').placeholder = status.token ? '(set — type none to clear)' : 'optional — relay may run tokenless';
  $('scope').value = status.scopeMode || 'tab';
  $('allowRow').classList.toggle('hidden', status.scopeMode !== 'allowlist');
  $('allowlist').value = (status.allowlist || []).join(', ');
  const box = $('tabs');
  box.innerHTML = '';
  const attached = status.attached || [];
  if (!attached.length) { box.innerHTML = '<div class="muted">none — open a tab and click this extension icon on it, then Opt-in below</div>'; return; }
  for (const a of attached) {
    const row = document.createElement('div');
    row.className = 'tab';
    const u = document.createElement('span'); u.className = 'u';
    u.textContent = `#${a.tabId} ${a.url || ''}`;
    const out = document.createElement('button'); out.textContent = 'Opt-out';
    out.onclick = () => chrome.runtime.sendMessage({ t: 'optOut', tabId: a.tabId }, refresh);
    row.append(u, out);
    box.append(row);
  }
}

async function currentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch { return null; }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ t: 'getStatus' });
  render(status);
}

$('scope').onchange = () => $('allowRow').classList.toggle('hidden', $('scope').value !== 'allowlist');

$('save').onclick = async () => {
  const tokenField = $('token').value.trim();
  // "none" (or literal empty on first configure) clears the token;
  // otherwise blank keeps the stored one — no way to silently lose auth
  let token = tokenField;
  if (tokenField === 'none' || tokenField.toLowerCase() === 'none') token = '';
  if (tokenField === '') token = undefined; // undefined = keep existing
  const opts = {
    relay: $('relay').value.trim(),
    token,
    configured: true,
    scopeMode: $('scope').value,
    allowlist: $('allowlist').value.split(',').map(s => s.trim()).filter(Boolean),
  };
  await chrome.runtime.sendMessage({ t: 'saveOpts', opts });
  setTimeout(refresh, 400);
};

$('discover').onclick = async () => {
  $('discover').textContent = 'Scanning…';
  const r = await chrome.runtime.sendMessage({ t: 'discover' });
  $('discover').textContent = 'Discover';
  if (r && r.ok) { setTimeout(refresh, 300); }
  else { $('status').textContent = r && r.error ? r.error : 'no relay found'; $('status').className = 'bad'; }
};

$('optin').onclick = async () => {
  const tab = await currentTab();
  if (!tab) return;
  await chrome.runtime.sendMessage({ t: 'optIn', tabId: tab.id });
  setTimeout(refresh, 300);
};

$('revoke').onclick = async () => {
  await chrome.runtime.sendMessage({ t: 'disconnectAgent' });
  setTimeout(refresh, 300);
};

// show setup hint immediately, before first getStatus resolves
render({ connected: false, relay: '', scopeMode: 'tab', allowlist: [], attached: [], keepalive: null });
refresh();

// live-refresh while the popup is open so the user can watch it come up
setInterval(refresh, 2000);
