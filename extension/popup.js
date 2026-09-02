// tailbrowser M0 popup
const $ = (id) => document.getElementById(id);

function render(status) {
  const configured = status.configured === true;
  const unconfigured = !configured;
  $('status').textContent = unconfigured ? 'Not configured — enter relay URL, then Save'
    : status.connected ? 'Connected to relay' : 'Connecting / relay unreachable…';
  $('status').className = status.connected ? 'ok' : 'bad';
  $('relay').value = status.relay || '';
  if (!unconfigured) $('token').placeholder = status.token ? '(set — leave blank to keep)' : 'optional — relay may run tokenless';
  $('scope').value = status.scopeMode || 'tab';
  $('allowRow').classList.toggle('hidden', status.scopeMode !== 'allowlist');
  $('allowlist').value = (status.allowlist || []).join(', ');
  const box = $('tabs');
  box.innerHTML = '';
  if (!status.attached.length) { box.innerHTML = '<div class="muted">none — open a tab and click this extension icon on it, then Opt-in below</div>'; return; }
  for (const tabId of status.attached) {
    const row = document.createElement('div');
    row.className = 'tab';
    const u = document.createElement('span'); u.className = 'u'; u.textContent = '#' + tabId;
    const out = document.createElement('button'); out.textContent = 'Opt-out';
    out.onclick = () => chrome.runtime.sendMessage({ t: 'optOut', tabId }, refresh);
    row.append(u, out);
    box.append(row);
  }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ t: 'getStatus' });
  render(status);
}

$('scope').onchange = () => $('allowRow').classList.toggle('hidden', $('scope').value !== 'allowlist');

$('save').onclick = async () => {
  const opts = {
    relay: $('relay').value.trim(),
    token: $('token').value.trim(),
    configured: true,
    scopeMode: $('scope').value,
    allowlist: $('allowlist').value.split(',').map(s => s.trim()).filter(Boolean),
  };
  // blank token field on save = clear the token (tokenless mode)
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
render({ connected: false, relay: '', scopeMode: 'tab', allowlist: [], attached: [] });
refresh();
