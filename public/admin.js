/* Administration panel. Every call here is refused for non-admin accounts. */
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = { users: [], departments: [], editing: null, canned: [] };

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (res.status === 403) { location.href = '/app'; throw new Error('forbidden'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/* ---------------- people ---------------- */

async function loadUsers() {
  state.users = await api('/api/admin/users');
  const body = $('usersTable').querySelector('tbody');
  body.innerHTML = '';
  $('peopleCount').textContent = '(' + state.users.length + ')';

  for (const u of state.users) {
    const tr = el('tr');
    if (u.disabled) tr.classList.add('disabled-row');

    const dotColour = u.online ? 'var(--green)' : '#c3ccd6';
    tr.appendChild(el('td', '', `
      <div class="cell-person">
        <span class="presence-dot" style="background:${dotColour}"></span>
        <div>
          <div class="cell-name">${esc(u.name)}</div>
          ${u.statusText ? `<div class="cell-sub">${esc(u.statusText)}</div>` : ''}
        </div>
      </div>`));
    tr.appendChild(el('td', '', `<div>${esc(u.username || '')}</div><div class="cell-sub">${esc(u.email || '')}</div>`));
    tr.appendChild(el('td', '', `<span class="role role-${esc(u.role)}">${esc(u.role === 'admin' ? 'Administrator' : u.role === 'manager' ? 'Manager' : 'Member')}</span>`));
    tr.appendChild(el('td', '', esc(u.department || '—')));
    tr.appendChild(el('td', '', u.twoFactor
      ? '<span class="state on">On</span>'
      : '<span class="state">Off</span>'));
    tr.appendChild(el('td', '', u.disabled
      ? '<span class="state off">Disabled</span>'
      : u.online ? '<span class="state on">Online</span>' : '<span class="state">Offline</span>'));
    tr.appendChild(el('td', 'cell-sub', esc(fmtWhen(u.lastSeen))));

    const actions = el('td', 'cell-actions');
    const edit = el('button', 'btn tiny', 'Edit');
    edit.addEventListener('click', () => openUserModal(u));
    actions.appendChild(edit);

    const toggle = el('button', 'btn tiny', u.disabled ? 'Enable' : 'Disable');
    toggle.addEventListener('click', async () => {
      try {
        await api('/api/admin/users/' + u.id, {
          method: 'PATCH', body: JSON.stringify({ disabled: !u.disabled }),
        });
        toast(u.disabled ? 'Account enabled' : 'Account disabled');
        loadUsers();
      } catch (err) { toast(err.message); }
    });
    actions.appendChild(toggle);

    const del = el('button', 'btn tiny danger', 'Delete');
    del.addEventListener('click', async () => {
      const ok = await askConfirm('Delete this account?',
        `${u.name} is removed and signed out everywhere. Their messages stay in the chats they were part of.`,
        'DELETE', 'Delete account');
      if (!ok) return;
      try {
        await api('/api/admin/users/' + u.id, { method: 'DELETE' });
        toast('Account deleted');
        loadUsers();
      } catch (err) { toast(err.message); }
    });
    actions.appendChild(del);

    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

function openUserModal(user) {
  state.editing = user || null;
  $('userModalTitle').textContent = user ? 'Edit ' + user.name : 'Add person';
  $('uName').value = user ? user.name : '';
  $('uUsername').value = user ? user.username || '' : '';
  $('uEmail').value = user ? user.email || '' : '';
  $('uRole').value = user ? user.role : 'member';
  $('uDept').value = user ? user.departmentId || '' : '';
  $('uPassword').value = '';
  $('uPasswordLabel').textContent = user ? 'New password (leave blank to keep)' : 'Password';
  $('uPassword').placeholder = user ? 'Leave blank to keep the current one' : 'At least 6 characters';
  const flags = (user && user.flags) || { files: true, otr: true, drive: true };
  $('uFiles').checked = flags.files !== false;
  $('uOtr').checked = flags.otr !== false;
  $('uDrive').checked = flags.drive !== false;
  $('user2fa').textContent = user
    ? (user.twoFactor ? 'Two-factor sign-in is on for this person.' : 'Two-factor sign-in is off for this person.')
    : '';
  $('user2faReset').hidden = !(user && user.twoFactor);
  $('userNote').textContent = user
    ? 'Changes take effect at their next sign-in.'
    : 'Give them this password privately. They can change it later.';
  $('userModal').classList.add('open');
  $('uName').focus();
}

async function saveUser() {
  const payload = {
    name: $('uName').value.trim(),
    username: $('uUsername').value.trim(),
    email: $('uEmail').value.trim(),
    role: $('uRole').value,
    departmentId: $('uDept').value || null,
    flags: {
      files: $('uFiles').checked,
      otr: $('uOtr').checked,
      drive: $('uDrive').checked,
    },
  };
  const password = $('uPassword').value;
  if (!payload.name) { toast('Name is required'); return; }

  try {
    if (state.editing) {
      if (password) payload.password = password;
      await api('/api/admin/users/' + state.editing.id, {
        method: 'PATCH', body: JSON.stringify(payload),
      });
      toast('Saved');
    } else {
      if (!password) { toast('Set a password for the new account'); return; }
      payload.password = password;
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) });
      toast('Account created');
    }
    $('userModal').classList.remove('open');
    await loadUsers();
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- departments ---------------- */

async function loadDepartments() {
  state.departments = await api('/api/admin/departments');
  const body = $('deptTable').querySelector('tbody');
  body.innerHTML = '';

  const sel = $('uDept');
  const keep = sel.value;
  sel.innerHTML = '<option value="">None</option>';
  for (const d of state.departments) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name;
    sel.appendChild(o);
  }
  sel.value = keep;

  if (!state.departments.length) {
    body.appendChild(el('tr', '', '<td colspan="3" class="cell-sub">No departments yet.</td>'));
    return;
  }
  for (const d of state.departments) {
    const tr = el('tr');
    tr.appendChild(el('td', 'cell-name', esc(d.name)));
    tr.appendChild(el('td', '', String(d.people)));
    const td = el('td', 'cell-actions');
    const del = el('button', 'btn tiny danger', 'Delete');
    del.addEventListener('click', async () => {
      const ok = await askConfirm('Delete this department?',
        `People in ${d.name} stay, but lose their department tag.`, 'DELETE', 'Delete');
      if (!ok) return;
      try {
        await api('/api/admin/departments/' + d.id, { method: 'DELETE' });
        toast('Department deleted');
        loadDepartments();
        loadUsers();
      } catch (err) { toast(err.message); }
    });
    td.appendChild(del);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

async function addDepartment() {
  const name = $('deptName').value.trim();
  if (!name) { toast('Type a department name'); return; }
  try {
    await api('/api/admin/departments', { method: 'POST', body: JSON.stringify({ name }) });
    $('deptName').value = '';
    toast('Department added');
    loadDepartments();
  } catch (err) { toast(err.message); }
}

/* ---------------- activity ---------------- */

async function loadBlocks() {
  const host = $('blockTable');
  if (!host) return;
  const body = host.querySelector('tbody');
  body.innerHTML = '';
  let rows = [];
  try { rows = await api('/api/admin/blocks'); } catch { rows = []; }
  if (!rows.length) {
    body.appendChild(el('tr', '', '<td colspan="6" class="cell-sub">Nobody is blocked.</td>'));
    return;
  }
  for (const b of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', '', esc(b.name || '—')));
    tr.appendChild(el('td', 'cell-sub', esc(b.ip || '—')));
    tr.appendChild(el('td', 'cell-sub', esc(b.host || '—')));
    tr.appendChild(el('td', 'cell-sub', esc(b.created_by || '—')));
    tr.appendChild(el('td', 'cell-sub', esc(fmtWhen(b.created_at))));
    const acts = el('td', 'cell-actions');
    if (b.ip) {
      const fw = el('button', 'btn tiny', 'Firewall');
      fw.addEventListener('click', async () => {
        try {
          const res = await api('/api/admin/firewall', { method: 'POST', body: JSON.stringify({ ip: b.ip.split(',')[0] }) });
          if (res.ok) toast('Windows Firewall now drops ' + b.ip);
          else toast('Run as administrator: ' + res.command);
        } catch (err) { toast(err.message); }
      });
      acts.appendChild(fw);
    }
    const del = el('button', 'btn tiny danger', 'Unblock');
    del.addEventListener('click', async () => {
      try {
        await api('/api/admin/blocks/' + b.id, { method: 'DELETE' });
        toast('Unblocked');
        loadBlocks();
      } catch (err) { toast(err.message); }
    });
    acts.appendChild(del);
    tr.appendChild(acts);
    body.appendChild(tr);
  }
}

async function addBlockFrom(row) {
  const payload = {};
  if (row && row.ip) payload.ip = row.ip;
  if (row && row.who) payload.name = row.who;
  if (!row) {
    const name = $('blockName').value.trim();
    const ip = $('blockIp').value.trim();
    const host = $('blockHost').value.trim();
    if (name) payload.name = name;
    if (ip) payload.ip = ip;
    if (host) payload.host = host;
    if (!name && !ip && !host) return toast('Give a name, an address or a DNS name');
  }
  try {
    await api('/api/admin/blocks', { method: 'POST', body: JSON.stringify(payload) });
    ['blockName', 'blockIp', 'blockHost'].forEach((k) => { const n = $(k); if (n) n.value = ''; });
    toast('Blocked');
    loadBlocks();
    loadSignins();
  } catch (err) { toast(err.message); }
}

const addBlockBtn = $('btnAddBlock');
if (addBlockBtn) addBlockBtn.addEventListener('click', () => addBlockFrom(null));

/* A ready-to-send letter about the refusals, addressed to the domain's admin. */
function openAbuseLetter(letter) {
  const back = el('div', 'modal-back open');
  const box = el('div', 'modal');
  box.style.maxWidth = '660px';
  const head = el('div', 'mhead', 'Letter to ' + letter.to);
  const body = el('div', 'mbody');
  const note = el('div', 'note', letter.attempts
    ? letter.attempts + ' refused attempt' + (letter.attempts === 1 ? '' : 's') + ' from '
      + letter.addresses + ' address' + (letter.addresses === 1 ? '' : 'es') + ' in the last ' + letter.hours + ' hours.'
    : 'No refused attempts in the last ' + letter.hours + ' hours, so the letter says exactly that.');
  const ta = el('textarea');
  ta.value = letter.body;
  ta.readOnly = true;
  ta.style.cssText = 'width:100%;min-height:320px;font:12px/1.5 ui-monospace,Consolas,monospace;border:1px solid var(--border);border-radius:8px;padding:10px;overflow:auto;white-space:pre';
  body.append(note, ta);
  const foot = el('div', 'mfoot');
  const mail = el('button', 'btn', 'Open in mail app');
  mail.addEventListener('click', () => {
    location.href = 'mailto:' + encodeURIComponent(letter.to).replace(/%40/g, '@')
      + '?subject=' + encodeURIComponent(letter.subject) + '&body=' + encodeURIComponent(letter.body);
  });
  const copy = el('button', 'btn primary', 'Copy letter');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ta.value);
      toast('Letter copied');
    } catch {
      ta.focus(); ta.select();
      try { document.execCommand('copy'); toast('Letter copied'); }
      catch { toast('Select the text and press Ctrl+C'); }
    }
  });
  const close = el('button', 'btn ghost', 'Close');
  close.addEventListener('click', () => back.remove());
  foot.append(mail, copy, close);
  box.append(head, body, foot);
  back.appendChild(box);
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  ta.focus();
  ta.setSelectionRange(0, 0);
}

const abuseBtn = $('btnAbuseLetter');
if (abuseBtn) {
  abuseBtn.addEventListener('click', async () => {
    try {
      const letter = await api('/api/admin/abuse-letter');
      openAbuseLetter(letter);
    } catch (err) { toast(err.message || 'Could not build the letter'); }
  });
}

async function loadSignins() {
  const host = $('signinTable');
  if (!host) return;
  const body = host.querySelector('tbody');
  body.innerHTML = '';
  let rows = [];
  try { rows = await api('/api/admin/signins'); } catch { rows = []; }
  if (!rows.length) {
    body.appendChild(el('tr', '', '<td colspan="5" class="cell-sub">No sign-ins recorded yet.</td>'));
    return;
  }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', 'cell-sub', esc(fmtWhen(r.at))));
    const result = el('td');
    const badge = el('span', 'signin-badge ' + (r.ok ? 'ok' : 'bad'), r.ok ? 'Signed in' : 'Refused');
    result.appendChild(badge);
    if (!r.ok && r.note) result.appendChild(el('div', 'cell-sub', esc(r.note)));
    tr.appendChild(result);
    const who = el('td');
    who.appendChild(el('div', '', esc(r.who || '—')));
    if (r.handle && r.handle !== r.who) who.appendChild(el('div', 'cell-sub', 'tried as ' + esc(r.handle)));
    tr.appendChild(who);
    tr.appendChild(el('td', 'cell-sub', esc(r.ip || '?')));
    tr.appendChild(el('td', 'cell-sub', esc(r.host || '—')));
    tr.appendChild(el('td', 'cell-sub', esc(String(r.agent || '').slice(0, 60))));
    const acts = el('td', 'cell-actions');
    const block = el('button', 'btn tiny danger', 'Block');
    block.addEventListener('click', async () => {
      const ok = await askConfirm('Block this one?',
        'Name ' + (r.who || '(none)') + ' and address ' + (r.ip || '(none)') + ' will be refused at the door.',
        'BLOCK', 'Block');
      if (!ok) return;
      await addBlockFrom(r);
    });
    acts.appendChild(block);
    tr.appendChild(acts);
    body.appendChild(tr);
  }
}

async function loadAudit() {
  void loadSignins();
  void loadBlocks();
  const rows = await api('/api/admin/audit');
  const body = $('auditTable').querySelector('tbody');
  body.innerHTML = '';
  if (!rows.length) {
    body.appendChild(el('tr', '', '<td colspan="4" class="cell-sub">Nothing recorded yet.</td>'));
    return;
  }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', 'cell-sub', esc(fmtWhen(r.at))));
    tr.appendChild(el('td', '', esc(r.who)));
    tr.appendChild(el('td', '', esc(r.action)));
    tr.appendChild(el('td', 'cell-sub', esc(r.detail)));
    body.appendChild(tr);
  }
}

/* ---------------- server ---------------- */

async function loadPort() {
  try {
    const p = await api('/api/admin/port');
    $('manualPort').value = p.manual ? String(p.manual) : '';
    $('portInfo').textContent = 'Listening on ' + p.listening
      + (p.manual && p.manual !== p.listening ? ' — restart to use ' + p.manual : '');
  } catch { /* panel still usable */ }
}

const PATH_NAMES = { vpn: 'VPN tunnel', upnp: 'UPnP (home router)', manual: 'Manual forwarding' };

// What a choice will actually listen on. The VPN port is whatever it hands out,
// so it is shown only when the server knows it right now — never assumed.
function describePath(net, choice) {
  if (!net) return '';
  const live = net.port ? String(net.port) : 'this port';
  const configured = net.configuredPort ? String(net.configuredPort) : '3000';
  const restartNote = net.configuredPort && net.port && net.configuredPort !== net.port
    ? ' Restart is needed to move from ' + live + ' to ' + configured + '.'
    : '';
  if (choice === 'upnp') {
    return 'Will listen on ' + configured + ' — the home router forwards it, and your home address becomes public.' + restartNote;
  }
  if (choice === 'manual') {
    return 'Will listen on ' + configured + ' — you forward it yourself; the server asks nothing of the VPN or the router.' + restartNote;
  }
  if (net.vpnPort) {
    return 'Will listen on ' + net.vpnPort + ' — handed out by the VPN just now, not a fixed number.';
  }
  return 'The VPN decides the port when it starts, and it changes; no number is assumed here.';
}

function updatePathHint() {
  const sel = $('publicPath');
  const hint = $('pathHint');
  if (sel && hint) hint.textContent = describePath(state.net, sel.value);
}

async function loadPublicPath() {
  try {
    const net = await api('/api/net');
    state.net = net;
    const sel = $('publicPath');
    if (sel && net && net.publicPath) sel.value = net.publicPath;
    updatePathHint();
  } catch { /* panel still usable */ }
}

const pathSelect = $('publicPath');
if (pathSelect) pathSelect.addEventListener('change', updatePathHint);

const savePathBtn = $('btnSavePath');
if (savePathBtn) {
  savePathBtn.addEventListener('click', async () => {
    try {
      const res = await api('/api/admin/public-path', {
        method: 'POST', body: JSON.stringify({ path: $('publicPath').value }),
      });
      toast(res.restartRequired
        ? 'Saved — restart the server to use ' + (PATH_NAMES[res.path] || res.path)
        : 'Public path saved');
      await loadPublicPath();
    } catch (err) { toast(err.message || 'Could not save the public path'); }
  });
}

const savePortBtn = $('btnSavePort');
if (savePortBtn) {
  savePortBtn.addEventListener('click', async () => {
    try {
      const res = await api('/api/admin/port', {
        method: 'POST', body: JSON.stringify({ port: $('manualPort').value.trim() }),
      });
      toast(res.restartRequired ? 'Saved — restart the server to use port ' + res.manual : 'Port saved');
      await loadPort();
    } catch (err) { toast(err.message || 'Could not save the port'); }
  });
}

// Hang up: reload the server's view of its settings and refresh every window.
const hupBtn = $('btnHup');
if (hupBtn) {
  hupBtn.addEventListener('click', async () => {
    hupBtn.disabled = true;
    try {
      const res = await api('/api/admin/hup', { method: 'POST' });
      toast('Reloaded — everyone has the current settings' + (res && res.modules ? '' : ''));
      await loadServer();
    } catch (err) {
      toast(err.message || 'Reload failed');
    }
    hupBtn.disabled = false;
  });
}

// Network HUP: re-apply the public path only. Separate from the settings HUP
// above, because this one talks to the VPN and the router.
const netHupBtn = $('btnNetworkHup');
if (netHupBtn) {
  netHupBtn.addEventListener('click', async () => {
    netHupBtn.disabled = true;
    try {
      const res = await api('/api/admin/network-hup', { method: 'POST' });
      const detail = res.details && res.details.length ? ' — ' + res.details.join('; ') : '';
      toast((res.needsRestart ? res.message : (res.message || 'Network re-applied')) + detail);
      await loadServer();
    } catch (err) { toast(err.message || 'Network HUP failed'); }
    netHupBtn.disabled = false;
  });
}

function renderModules(list) {
  const host = $('moduleList');
  host.innerHTML = '';
  if (!list.length) { host.textContent = 'No modules reported by the server.'; return; }
  for (const m of list) {
    const row = el('label', 'module-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!m.on;
    box.addEventListener('change', async () => {
      const res = await api('/api/admin/settings', {
        method: 'POST', body: JSON.stringify({ modules: { [m.id]: box.checked } }),
      });
      if (res.error) { box.checked = !box.checked; return toast(res.error); }
      toast((box.checked ? 'Loaded ' : 'Unloaded ') + m.label);
    });
    const text = el('div', 'mtext');
    text.appendChild(el('div', 'mname', esc(m.label)));
    text.appendChild(el('div', 'mhint', esc(m.hint)));
    row.appendChild(box);
    row.appendChild(text);
    host.appendChild(row);
  }
}

function renderCommands(list) {
  const host = $('commandList');
  if (!host) return;
  host.innerHTML = '';
  if (!list.length) { host.textContent = 'No commands reported by the server.'; return; }
  for (const c of list) {
    const row = el('label', 'module-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!c.on;
    box.addEventListener('change', async () => {
      const res = await api('/api/admin/settings', {
        method: 'POST', body: JSON.stringify({ commands: { [c.id]: box.checked } }),
      });
      if (res.error) { box.checked = !box.checked; return toast(res.error); }
      toast((box.checked ? 'Switched on ' : 'Switched off ') + c.usage);
    });
    const text = el('div', 'mtext');
    text.appendChild(el('div', 'mname', esc(c.usage)));
    text.appendChild(el('div', 'mhint', esc(c.hint)));
    row.appendChild(box);
    row.appendChild(text);
    host.appendChild(row);
  }
}

/** One checkbox per day, Sunday first, matching JS Date.getDay(). */
function renderWorkDays(days) {
  const on = new Set(days.split(',').filter(Boolean));
  const host = $('workHoursDays');
  if (!host) return;
  host.innerHTML = '';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((label, i) => {
    const lab = document.createElement('label');
    lab.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:13px';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.day = String(i);
    box.checked = on.has(String(i));
    lab.append(box, document.createTextNode(label));
    host.appendChild(lab);
  });
}

async function loadServer() {
  const [overview, net, canned, policy, keys] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/net'),
    api('/api/canned'),
    api('/api/admin/settings'),
    api('/api/admin/api-tokens'),
  ]);
  $('otrAllowed').checked = !!(policy && policy.otrAllowed);

  $('turnKeyId').value = (policy && policy.turnKeyId) || '';
  $('turnApiToken').value = '';
  $('turnInfo').textContent = policy && policy.turnConfigured
    ? 'Relay configured. Calls fall back to it only when a direct connection cannot be made.'
    : 'No relay yet — calls only work when both devices can reach each other directly.';

  const wh = (policy && policy.workHours) || {};
  $('workHoursOn').checked = !!wh.on;
  $('workHoursFrom').value = wh.from || '09:00';
  $('workHoursTo').value = wh.to || '17:00';
  $('workHoursNote').value = wh.note || '';
  renderWorkDays(String(wh.days || '1,2,3,4,5'));
  $('workHoursInfo').textContent = !wh.on
    ? 'Off — the app never closes.'
    : (policy && policy.workOpen === false)
      ? 'Closed right now: visitors see the closed page until the next opening time.'
      : 'Open right now.';
  $('driveQuota').value = String((policy && policy.driveQuotaMb) || 1024);
  renderKeys((keys && keys.tokens) || []);
  $('require2fa').checked = !!(policy && policy.require2fa);
  $('messagePolicy').value = (policy && policy.messagePolicy) || 'everyone';
  $('retentionDays').value = String((policy && policy.retentionDays) || 0);
  $('retentionInfo').textContent = (policy && policy.retentionDays)
    ? 'Chat older than ' + policy.retentionDays + ' days is deleted; customer threads are kept. Last sweep: '
      + (policy.retentionLastRun ? new Date(policy.retentionLastRun).toLocaleString() : 'not run yet') + '.'
    : 'Everything is kept until someone deletes it.';
  $('publicUrl').value = (policy && policy.publicUrl) || '';
  $('publicUrlInfo').textContent = 'Links and emails use: ' + ((policy && policy.linksUse) || '');
  renderModules((policy && policy.modules) || []);
  loadDdns().catch(() => {});
  renderCommands((policy && policy.commands) || []);
  void loadPort();
  void loadPublicPath();
  const backups = await api('/api/admin/backups');
  renderBackups((backups && backups.backups) || []);

  const cards = [
    ['People', overview.users + ' (' + overview.activeUsers + ' active)'],
    ['Online now', String(overview.online)],
    ['Departments', String(overview.departments)],
    ['Client threads', String(overview.clients)],
    ['Rooms', String(overview.rooms)],
    ['Messages', String(overview.messages)],
    ['Files', overview.files + ' · ' + fmtBytes(overview.storedBytes)],
  ];
  const host = $('serverCards');
  host.innerHTML = '';
  for (const [label, value] of cards) {
    host.appendChild(el('div', 'card', `<div class="cval">${esc(value)}</div><div class="clab">${esc(label)}</div>`));
  }

  const lines = [];
  lines.push(['Links use', overview.linksUse]);
  lines.push(['Public path', PATH_NAMES[net.publicPath] || PATH_NAMES.vpn]);
  for (const u of overview.lan) lines.push(['On this network', u]);
  if (net.mapped && net.mapped.ok) {
    lines.push(['Router mapping', net.mapped.method + (net.mapped.externalPort ? ' · port ' + net.mapped.externalPort : '')]);
    if (net.mapped.publicIp) lines.push(['Public address', net.mapped.publicIp]);
  } else {
    lines.push(['Router mapping', 'Not available' + (net.mapped && net.mapped.error ? ' — ' + net.mapped.error : '')]);
    lines.push(['What to do', net.publicPath === 'manual'
      ? 'Forward TCP ' + overview.port + ' to this computer on whatever router you use.'
      : net.publicPath === 'upnp'
        ? 'Turn on UPnP in the router, or forward TCP ' + overview.port + ' by hand.'
        : 'Nothing — the VPN is carrying the traffic. Switch the public path to UPnP to use the home router instead.']);
  }
  if (net.vpn && net.vpn.addresses && net.vpn.addresses.length) {
    lines.push(['VPN', net.vpn.addresses.map((a) => a.address + ' (' + a.name + ')').join(', ')]);
    if (net.vpn.ports && net.vpn.ports.length) lines.push(['VPN ports', net.vpn.ports.join(', ')]);
  } else {
    lines.push(['VPN', 'No VPN adapter detected on this computer']);
  }
  $('netBox').innerHTML = lines
    .map(([k, v]) => `<div class="netrow"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join('');

  // The router's address. A phone cannot read its own routing table, so on
  // Android this field is the reliable answer rather than a nicety.
  // Restart and stop, from inside the panel.
  if (!document.getElementById('btnRestartServer').dataset.wired) {
    document.getElementById('btnRestartServer').dataset.wired = '1';
    const info = $('powerInfo');
    const power = async (action) => {
      const ask = action === 'stop'
        ? 'Stop the server? On the phone it stays stopped until the app is opened again.'
        : 'Restart the server now? Open pages will need a refresh once it is back.';
      if (!window.confirm(ask)) return;
      info.textContent = action === 'stop' ? 'Stopping\u2026' : 'Restarting\u2026';
      try {
        await api('/api/admin/power', { method: 'POST', body: JSON.stringify({ action }) });
        info.textContent = action === 'stop'
          ? 'Stopped. Open the app on the phone to start it again.'
          : 'Restarting \u2014 this page will stop answering for a second, then reload it.';
        if (action === 'restart') setTimeout(() => window.location.reload(), 2500);
      } catch (err) {
        info.textContent = 'Could not do that: ' + ((err && err.message) || 'the server refused it');
      }
    };
    $('btnRestartServer').addEventListener('click', () => { void power('restart'); });
    $('btnStopServer').addEventListener('click', () => { void power('stop'); });
  }

  // A clean copy: built here, downloaded from here, with none of this install in it.
  if (!document.getElementById('btnCleanBuild').dataset.wired) {
    document.getElementById('btnCleanBuild').dataset.wired = '1';
    const info = $('cleanInfo');
    const dl = $('cleanDownload');
    $('btnCleanBuild').addEventListener('click', async () => {
      info.textContent = 'Building\u2026 a few seconds.';
      dl.hidden = true;
      try {
        const res = await api('/api/admin/clean-package', { method: 'POST', body: '{}' });
        if (!res || !res.ok) { info.textContent = 'The server did not build it.'; return; }
        const mb = (res.bytes / 1048576).toFixed(1);
        info.textContent = res.name + ' \u2014 ' + res.files + ' files, ' + mb + ' MB.';
        dl.href = res.url;
        dl.setAttribute('download', res.name);
        dl.textContent = 'Download ' + mb + ' MB';
        dl.hidden = false;
      } catch (err) {
        info.textContent = 'Could not build it: ' + ((err && err.message) || 'the server refused');
      }
    });
  }

  // Updating the app itself: one address, then the phone does the rest.
  if (!document.getElementById('btnCheckUpdate').dataset.wired) {
    document.getElementById('btnCheckUpdate').dataset.wired = '1';
    const info = $('updateInfo');
    $('appVersion').textContent = (window.PeachApp && PeachApp.version) ? PeachApp.version() : 'web page';
    api('/api/admin/app-update')
      .then((res) => { if (res && res.url) $('updateUrl').value = res.url; })
      .catch(() => {});
    $('btnSaveUpdateUrl').addEventListener('click', async () => {
      const url = $('updateUrl').value.trim();
      try {
        await api('/api/admin/app-update', { method: 'POST', body: JSON.stringify({ url }) });
        info.textContent = url ? 'Address saved.' : 'Address cleared.';
      } catch (err) {
        info.textContent = 'Could not save that: ' + ((err && err.message) || 'the server refused it');
      }
    });
    $('btnCheckUpdate').addEventListener('click', () => {
      const url = $('updateUrl').value.trim();
      if (!url) { info.textContent = 'Paste an APK address first.'; return; }
      if (!window.PeachApp || !PeachApp.installUpdate) {
        // A browser cannot install an APK, but it can ask the app to. The phone's
        // service is watching for exactly this and answers with a notification.
        info.textContent = 'Queuing\u2026';
        api('/api/admin/app-update/apply', { method: 'POST', body: JSON.stringify({ url }) })
          .then((res) => {
            info.textContent = (res && res.ok)
              ? 'Queued. The phone will offer the update in a moment \u2014 tap its notification.'
              : 'Could not queue it.';
          })
          .catch((err) => {
            info.textContent = 'Could not queue it: ' + ((err && err.message) || 'the server refused it');
          });
        return;
      }
      info.textContent = 'Checking\u2026';
      PeachApp.installUpdate(url);
    });
    // The app answers here once it has looked at the file.
    window.peachUpdateResult = (res) => {
      info.textContent = (res && res.message) || 'No answer from the app.';
    };
  }

  const gwField = $('gatewayIp');
  if (gwField) {
    gwField.value = net.gateway || '';
    const guesses = (net.gatewayGuess || []).filter(Boolean);
    $('gatewayInfo').textContent = guesses.length
      ? 'Leave it empty and the app tries: ' + guesses.join(', ') + '.'
      : 'Leave it empty and the app guesses from this machine\u2019s own address.';

    if (!gwField.dataset.wired) {
      gwField.dataset.wired = '1';
      const portField = $('publicPort');
      if (portField) {
        portField.value = net.externalPort ? String(net.externalPort) : '';
        const savePort = $('btnSavePort');
        if (savePort) {
          savePort.addEventListener('click', async () => {
            savePort.disabled = true;
            try {
              await api('/api/admin/external-port', { method: 'POST', body: JSON.stringify({ port: portField.value.trim() }) });
              toast(portField.value.trim() ? 'Public port saved' : 'Public port cleared');
            } catch (err) {
              toast('Could not save: ' + ((err && err.message) || 'the server refused it'));
            }
            savePort.disabled = false;
          });
        }
      }

      const check = $('btnRouterCheck');
      if (check) {
        check.addEventListener('click', async () => {
          const out = $('routerOut');
          out.style.display = 'block';
          out.textContent = 'Asking the router\u2026 (this takes a few seconds)';
          check.disabled = true;
          try {
            const result = await api('/api/admin/router-check', { method: 'POST' });
            out.textContent = (result.lines || []).join('\n') +
              (result.ok ? '\n\nThat worked \u2014 the router is forwarding the port.'
                         : '\n\nThat did not work. The line above is where it stopped.');
          } catch (err) {
            out.textContent = 'Could not run the check: ' + ((err && err.message) || 'the server refused it');
          }
          check.disabled = false;
        });
      }

      const save = $('btnSaveGateway');
      if (save) {
        save.addEventListener('click', async () => {
          save.disabled = true;
          try {
            await api('/api/admin/gateway', { method: 'POST', body: JSON.stringify({ ip: gwField.value.trim() }) });
            toast(gwField.value.trim() ? 'Router address saved' : 'Router address cleared \u2014 the app will guess');
          } catch (err) {
            toast('Could not save: ' + ((err && err.message) || 'the server refused it'));
          }
          save.disabled = false;
        });
      }
    }
  }

  renderManualNet(net, overview);

  state.canned = canned;
  const body = $('cannedTable').querySelector('tbody');
  body.innerHTML = '';
  for (const c of canned) {
    const tr = el('tr');
    tr.appendChild(el('td', 'cell-name', esc(c.shortcut)));
    tr.appendChild(el('td', '', esc(c.body)));
    body.appendChild(tr);
  }
}

// The router's own form, filled in. The admin panel already knows every value
// a person would otherwise have to look up, so it hands them over instead of
// describing what to do.
function renderManualNet(net, overview) {
  const host = $('manualNet');
  const tick = $('showManualNet');
  if (!host || !tick) return;

  const lanHost = (function () {
    for (const u of (overview.lan || [])) {
      try { return new URL(u).hostname; } catch { /* next */ }
    }
    return '';
  })();
  const externalPort = (net.mapped && net.mapped.externalPort) || overview.port;
  // Only a real address the router reported. Falling back to the link the panel
  // uses produced "http://http://10.0.0.215:3000:3000", which is what happens
  // when a full URL is fed into a string that already has a scheme in it.
  const publicIp = (net.mapped && net.mapped.publicIp) || '';
  const name = net.name || '';

  // Editable, because a router rule is the operator's to change: another port,
  // a fixed address, a name they already own. The app fills them in; it does not
  // lock them.
  const fieldStyle = 'width:100%;max-width:230px;padding:5px 7px;border:1px solid #cfd7e3;border-radius:6px;font:inherit;background:#fff';
  const rowHtml = (label, control) => `<div class="netrow"><span class="k">${esc(label)}</span><span class="v">${control}</span></div>`;
  const portField = (id, value) => `<input id="${id}" type="number" min="1" max="65535" inputmode="numeric" value="${esc(String(value))}" style="${fieldStyle}">`;
  const textField = (id, value, placeholder) => `<input id="${id}" type="text" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}" style="${fieldStyle}">`;

  // What to do next, said once, with this machine's own numbers in it. The part
  // nobody discovers on their own is that the installer cannot test the public
  // address from the machine serving it.
  const lanUrl = lanHost ? 'http://' + lanHost + ':' + overview.port : '';
  const byAddress = publicIp ? 'http://' + publicIp.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') + ':' + externalPort : '';
  const publicUrl = overview.linksUse || byAddress;
  // A link the operator can tap. The href is the address that actually works;
  // the text is free, so it can be the name they think of the server by.
  const linkTo = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label || url)}</a>`;

  // Two codes, because they answer different questions. The LAN one proves the
  // server answers; only the public one proves the router lets the world in.
  const qrTargets = [];
  if (lanUrl) qrTargets.push({ url: lanUrl, label: 'On this network', note: 'a phone or second computer on the same Wi-Fi' });
  if (publicUrl && publicUrl !== lanUrl) qrTargets.push({ url: publicUrl, label: 'From outside', note: 'any device outside this network \u2014 a phone on mobile data, a laptop on a hotspot, someone else\u2019s computer' });
  const qrHtml = qrTargets.length
    ? '<div style="display:flex;gap:18px;flex-wrap:wrap;padding:12px 4px 2px;border-top:1px solid #e3e9f2;margin-top:10px">'
      + qrTargets.map((t, i) => '<div style="text-align:center">'
        + '<canvas class="mnetQr" data-url="' + esc(t.url) + '" id="mnetQr' + i + '" style="width:150px;height:150px;background:#fff;border:1px solid #dbe3ee;border-radius:8px;image-rendering:pixelated"></canvas>'
        + '<div style="font-size:12px;font-weight:600;margin-top:6px;color:#2c3a52">' + esc(t.label) + '</div>'
        + '<div class="hint" style="max-width:150px;margin:2px auto 0">' + esc(t.note) + '</div>'
        + '</div>').join('')
      + '</div>'
    : '';
  const notice =
    '<div style="background:#f3f7ff;border:1px solid #cfe0fb;border-radius:10px;padding:13px 15px;margin:0 0 10px;font-size:13px;line-height:1.55;color:#2c3a52">'
    + '<b>These settings have been filled in for you.</b> If you need to enter more advanced information, you can do it here.'
    + '<br><br><b>You cannot test your own address from this same system.</b> Use any device outside this network \u2014 a phone on mobile data, a laptop tethered to a phone, a computer somewhere else. Anything behind this router will fail, however you reach it.'
    + (lanUrl ? '<br><br>Working on this network right now: ' + linkTo(lanUrl) : '')
    + (publicUrl ? '<br>Test link: ' + linkTo(publicUrl, name || '')
      + ' <span style="color:#5a6b85">(open it on any device outside this network \u2014 this machine cannot reach its own public address)</span>' : '')
    + (byAddress && byAddress !== publicUrl ? '<br>By raw address: ' + esc(byAddress) + ' \u2014 this stops working when your ISP changes it.' : '')
    + '<br><br>To make these settings permanent with a dynamic IP address from your ISP, set up a free account at <b>noip.com</b> or one of your choice, and enter that information above. Along with a domain name you can remember, they secure your IP with SSL — so the address stays fixed and the connection stays protected.'
    + '</div>';

  host.innerHTML = notice
    + rowHtml('Protocol', textField('mnetProto', 'TCP'))
    + rowHtml('External port', portField('mnetExt', externalPort))
    + rowHtml('Internal address', textField('mnetAddr', lanHost, 'this computer\u2019s LAN address'))
    + rowHtml('Internal port', portField('mnetInt', overview.port))
    + (publicIp ? rowHtml('Public address', textField('mnetIp', publicIp)) : '')
    + rowHtml('Name (No-IP)', textField('mnetName', name, 'yourname.ddns.net'))
    + rowHtml('Working address', '<span id="mnetWorking" class="v">' + esc(overview.linksUse || '') + '</span>')
    + '<div id="mnetProtoNote" class="hint" style="margin:6px 4px 0;color:#8a5a00" hidden></div>'
    + '<div style="padding:10px 4px 2px"><button class="btn" id="btnCopyNet">Copy these values</button>'
    + '<span class="hint" id="copyNetMsg" style="margin-left:10px"></span></div>'
    + qrHtml
    + '<p class="hint" style="margin:8px 4px 2px">Fill these into the router\u2019s port-forwarding form. Changing a port or protocol here edits the rule you are about to type; it does not move the server \u2014 use the Port setting above for that.</p>';

  // The codes carry the address to a device that can actually reach it.
  if (typeof qrcode === 'function') {
    for (const canvas of host.querySelectorAll('canvas.mnetQr')) {
      try {
        const q = qrcode(0, 'M');
        q.addData(canvas.getAttribute('data-url'));
        q.make();
        const n = q.getModuleCount();
        const scale = 6;
        canvas.width = n * scale;
        canvas.height = n * scale;
        const g = canvas.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = '#101418';
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            if (q.isDark(r, c)) g.fillRect(c * scale, r * scale, scale, scale);
          }
        }
      } catch (err) { /* a missing code is not worth breaking the panel over */ }
    }
  }

  let copyText = '';
  const btn = $('btnCopyNet');
  if (btn) {
    btn.addEventListener('click', function () {
      const done = function () { $('copyNetMsg').textContent = 'Copied.'; };
      const read = function (id, fallback) {
        const box = $(id);
        const val = box ? String(box.value).trim() : '';
        return val || fallback;
      };
      const lines = [
        ['Protocol', read('mnetProto', 'TCP')],
        ['External port', read('mnetExt', String(externalPort))],
        ['Internal address', read('mnetAddr', lanHost)],
        ['Internal port', read('mnetInt', String(overview.port))],
        ['Public address', read('mnetIp', publicIp)],
        ['Name (No-IP)', read('mnetName', name)],
      ].filter(function (pair) { return pair[1]; });
      copyText = lines.map(function (pair) { return pair[0] + ': ' + pair[1]; }).join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(copyText).then(done, function () { $('copyNetMsg').textContent = 'Select the values and copy them.'; });
      } else {
        $('copyNetMsg').textContent = 'Select the values and copy them.';
      }
    });
  }

  const proto = $('mnetProto');
  if (proto) {
    proto.oninput = function () {
      const note = $('mnetProtoNote');
      if (!note) return;
      const mode = String(proto.value).trim().toUpperCase();
      if (mode === 'UDP') {
        note.textContent = 'UDP alone will forward nothing: this server answers only on TCP. Add TCP as well if you want the messenger to be reachable.';
        note.hidden = false;
      } else if (mode === 'TCP AND UDP' || mode === 'TCP+UDP' || mode === 'BOTH') {
        note.textContent = 'The messenger only uses the TCP rule; the UDP one is only of use to something else on this machine.';
        note.hidden = false;
      } else {
        note.hidden = true;
      }
    };
  }

  // Ticking asks the machine again rather than redrawing what the page loaded
  // with: the codes are built from the addresses as they are at that moment, and
  // the canvases are new elements each time, so nothing stale survives.
  tick.onchange = async function () {
    if (!tick.checked) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    try {
      const fresh = await api('/api/net');
      if (fresh && fresh.port) {
        renderManualNet(fresh, overview);
        host.hidden = false;
      }
    } catch (err) { /* keep what is on screen rather than blank it */ }
  };
  host.hidden = !tick.checked;
}

function renderBackups(list) {
  const body = $('backupTable').querySelector('tbody');
  body.innerHTML = '';
  if (!list.length) {
    const tr = el('tr');
    const td = el('td', 'hint', 'No backups yet.');
    td.colSpan = 4;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const b of list) {
    const tr = el('tr');
    tr.appendChild(el('td', 'cell-name', esc(b.name)));
    tr.appendChild(el('td', '', esc(fmtBytes(b.bytes))));
    tr.appendChild(el('td', 'cell-sub', esc(new Date(b.at).toLocaleString())));
    const td = el('td');
    const a = el('a', 'btn tiny', 'Download');
    a.href = '/api/admin/backups/' + encodeURIComponent(b.name);
    td.appendChild(a);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

function renderKeys(tokens) {
  const body = $('keyTable').querySelector('tbody');
  body.innerHTML = '';
  if (!tokens.length) {
    const tr = el('tr');
    const td = el('td', 'hint', 'No API keys yet.');
    td.colSpan = 5;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const t of tokens) {
    const tr = el('tr');
    tr.appendChild(el('td', 'cell-name', esc(t.name)));
    tr.appendChild(el('td', '', '<code>' + esc(t.prefix) + '…</code>'));
    tr.appendChild(el('td', '', esc(t.createdBy)));
    tr.appendChild(el('td', '', t.lastUsedAt ? esc(new Date(t.lastUsedAt).toLocaleString()) : 'Never'));
    const td = el('td');
    const revoke = el('button', 'btn tiny danger ghost', 'Revoke');
    revoke.addEventListener('click', async () => {
      const ok = await askConfirm('Revoke key', 'Anything using "' + t.name + '" stops working at once.', 'revoke', 'Revoke');
      if (!ok) return;
      await api('/api/admin/api-tokens/' + t.id, { method: 'DELETE' });
      toast('Key revoked');
      await loadServer();
    });
    td.appendChild(revoke);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

async function makeKey() {
  const name = $('keyName').value.trim();
  if (!name) { toast('Give the key a name'); return; }
  const scopes = $('keyWrite').checked ? ['read', 'write'] : ['read'];
  const res = await api('/api/admin/api-tokens', { method: 'POST', body: JSON.stringify({ name, scopes }) });
  if (res.error) { toast(res.error); return; }
  $('keyName').value = '';
  const box = $('keyOnce');
  box.hidden = false;
  box.innerHTML = '<div><strong>Copy this key now.</strong> It will not be shown again.</div>' +
    '<div style="margin-top:6px"><code>' + esc(res.token) + '</code></div>';
  const copy = el('button', 'btn tiny', 'Copy key');
  copy.style.marginTop = '7px';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(res.token); toast('Key copied'); }
    catch { toast('Select the key and press Ctrl+C'); }
  });
  box.appendChild(copy);
  toast('Key created');
  await loadServer();
}

async function addCanned() {
  const shortcut = $('cannedShortcut').value.trim();
  const body = $('cannedBody').value.trim();
  if (!shortcut || !body) { toast('Shortcut and message are both needed'); return; }
  try {
    await api('/api/canned', { method: 'POST', body: JSON.stringify({ shortcut, body }) });
    $('cannedShortcut').value = '';
    $('cannedBody').value = '';
    toast('Reply added');
    loadServer();
  } catch (err) { toast(err.message); }
}

/* ---------------- confirm ---------------- */

function askConfirm(title, message, word, label) {
  return new Promise((resolve) => {
    const back = el('div', 'modal-back open');
    const box = el('div', 'modal');
    box.style.maxWidth = '420px';
    const head = el('div', 'mhead', esc(title));
    const body = el('div', 'mbody');
    body.appendChild(el('div', 'note', esc(message)));
          // No typing: the button says what it does. Escape or a click outside cancels.
      const foot = el('div', 'mfoot');
      const cancel = el('button', 'btn ghost', 'Cancel');
      const ok = el('button', 'btn danger', label || 'Confirm');
      foot.append(cancel, ok);
      box.append(head, body, foot);
      back.appendChild(box);
      document.body.appendChild(back);
      ok.focus();

      function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') finish(false);
      }
      function finish(v) {
        document.removeEventListener('keydown', onKey);
        back.remove();
        resolve(v);
      }

      document.addEventListener('keydown', onKey);
      ok.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      back.addEventListener('click', (e) => { if (e.target === back) finish(false); });
  });
}

/* ---------------- wiring ---------------- */

/* ---------------- work: time off, holidays, reports ---------------- */

const LEAVE_KIND = { annual: 'Annual leave', sick: 'Sick leave', personal: 'Personal', unpaid: 'Unpaid' };

function dateInputValue(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderLeave(rows) {
  const body = $('leaveTable').querySelector('tbody');
  body.innerHTML = '';
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'cell-sub', 'No time off has been requested yet.');
    td.colSpan = 6;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', 'cell-name', esc(r.name)));
    tr.appendChild(el('td', '', esc(LEAVE_KIND[r.kind] || r.kind)));
    tr.appendChild(el('td', '', esc(r.startsOn === r.endsOn ? r.startsOn : r.startsOn + ' → ' + r.endsOn)));
    tr.appendChild(el('td', '', String(r.days)));
    tr.appendChild(el('td', '', `<span class="leave-badge ${esc(r.status)}">${esc(r.status)}</span>`));
    const actions = el('td', 'cell-actions');
    if (r.status === 'pending') {
      const yes = el('button', 'btn tiny primary', 'Approve');
      yes.addEventListener('click', () => decideLeave(r, true));
      const no = el('button', 'btn tiny danger', 'Decline');
      no.addEventListener('click', () => decideLeave(r, false));
      actions.append(yes, no);
    } else if (r.decidedAt) {
      actions.appendChild(el('span', 'cell-sub', esc(fmtWhen(r.decidedAt))));
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

async function decideLeave(request, approve) {
  if (!approve && !(await askConfirm('Decline time off', `Tell ${request.name} their request is not approved.`, 'decline', 'Decline request'))) return;
  try {
    await api('/api/admin/leave/' + request.id + '/decide', {
      method: 'POST', body: JSON.stringify({ approve }),
    });
    toast(approve ? 'Time off approved' : 'Time off declined');
    await loadWork();
  } catch (err) {
    toast(err.message);
  }
}

async function renderHolidays(rows) {
  const body = $('holidayTable').querySelector('tbody');
  body.innerHTML = '';
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'cell-sub', 'No holidays set.');
    td.colSpan = 3;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const h of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', '', esc(h.day)));
    tr.appendChild(el('td', 'cell-name', esc(h.name)));
    const actions = el('td', 'cell-actions');
    const del = el('button', 'btn tiny danger', 'Remove');
    del.addEventListener('click', async () => {
      try {
        await api('/api/admin/holidays/' + h.id, { method: 'DELETE' });
        await loadWork();
        toast('Holiday removed');
      } catch (err) {
        toast(err.message);
      }
    });
    actions.appendChild(del);
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

function reportRange() {
  const to = $('repTo').value ? new Date($('repTo').value + 'T23:59:59').getTime() : Date.now();
  const from = $('repFrom').value ? new Date($('repFrom').value + 'T00:00:00').getTime() : to - 13 * 86400000;
  return { from, to };
}

async function loadHoursReport() {
  const { from, to } = reportRange();
  const userId = $('repPerson').value;
  const data = await api(`/api/reports/hours?from=${from}&to=${to}${userId ? '&userId=' + encodeURIComponent(userId) : ''}`);
  const body = $('hoursTable').querySelector('tbody');
  body.innerHTML = '';
  const rows = (data.rows || []).slice().sort((a, b) => b.minutes - a.minutes);
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'cell-sub', 'Nobody has any recorded time in this range.');
    td.colSpan = 3;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', 'cell-name', esc(r.name)));
    tr.appendChild(el('td', '', String(r.days)));
    const h = Math.floor(r.minutes / 60);
    const m = r.minutes % 60;
    tr.appendChild(el('td', '', `${h} h ${String(m).padStart(2, '0')} m`));
    body.appendChild(tr);
  }
}

async function loadWork() {
  try {
    const [leave, holidays, users] = await Promise.all([
      api('/api/admin/leave'), api('/api/admin/holidays'), api('/api/admin/users'),
    ]);
    renderLeave(leave.requests || []);
    renderHolidays(holidays || []);
    const sel = $('repPerson');
    const keep = sel.value;
    sel.innerHTML = '<option value="">Everyone</option>';
    for (const u of users) {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.name;
      sel.appendChild(o);
    }
    sel.value = users.some((u) => u.id === keep) ? keep : '';
    await loadHoursReport();
  } catch (err) {
    toast(err.message);
  }
}

function wire() {
  document.querySelectorAll('.atab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.atab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.apanel').forEach((p) => p.classList.remove('active'));
      $('panel-' + b.dataset.panel).classList.add('active');
      if (b.dataset.panel === 'activity') loadAudit();
      if (b.dataset.panel === 'server') loadServer();
      if (b.dataset.panel === 'departments') loadDepartments();
      if (b.dataset.panel === 'work') loadWork();
    });
  });

  $('btnAddUser').addEventListener('click', () => openUserModal(null));
  $('userCancel').addEventListener('click', () => $('userModal').classList.remove('open'));
  $('userSave').addEventListener('click', saveUser);
  $('uPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveUser(); });

  $('btnAddDept').addEventListener('click', addDepartment);
  $('deptName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDepartment(); });
  $('btnReloadAudit').addEventListener('click', loadAudit);
  $('btnReloadServer').addEventListener('click', loadServer);
  $('btnMakeKey').addEventListener('click', () => makeKey().catch((e) => toast(e.message)));

  $('require2fa').addEventListener('change', async (e) => {
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ require2fa: e.target.checked }) });
    toast(e.target.checked ? 'Two-factor is required' : 'Two-factor is optional');
  });
  $('messagePolicy').addEventListener('change', async (e) => {
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ messagePolicy: e.target.value }) });
    toast('Private chat rule saved');
  });
  $('btnSaveRetention').addEventListener('click', async () => {
    const days = Math.max(0, Math.min(3650, Number($('retentionDays').value) || 0));
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ retentionDays: days }) });
    toast(days ? 'History kept for ' + days + ' days' : 'History kept forever');
    await loadServer();
  });
  $('btnRunRetention').addEventListener('click', async () => {
    const res = await api('/api/admin/retention/run', { method: 'POST', body: JSON.stringify({}) });
    if (res.error) return toast(res.error);
    toast(res.removed ? res.removed + ' old messages removed' : 'Nothing was old enough to remove');
    await loadServer();
  });
  $('btnSavePublicUrl').addEventListener('click', async () => {
    const res = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ publicUrl: $('publicUrl').value.trim() }) });
    if (res.error) return toast(res.error);
    toast('Public address saved');
    await loadServer();
  });
  $('btnBackup').addEventListener('click', async () => {
    const res = await api('/api/admin/backups', { method: 'POST', body: JSON.stringify({}) });
    if (res.error) return toast(res.error);
    toast('Backup made: ' + res.name);
    await loadServer();
  });
  $('btnRestore').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const ok = await askConfirm('Restore the database?',
      'Every account, chat, file record and setting is replaced with the copy in ' + file.name +
      '. A safety copy of the current database is made first, but this cannot be undone from the panel.',
      'RESTORE', 'Restore');
    if (!ok) return;
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/admin/restore', { method: 'POST', credentials: 'same-origin', body: buf });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'That file could not be restored');
    toast('Restored ' + data.rows + ' rows. Sign in again if anything looks off.');
    await loadServer();
  });
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const csv = await file.text();
    const res = await api('/api/admin/directory/import', { method: 'POST', body: JSON.stringify({ csv }) });
    if (res.error) return toast(res.error);
    const box = $('importResult');
    box.hidden = false;
    box.innerHTML = '<strong>' + res.created + ' created, ' + res.updated + ' updated, ' + res.skipped + ' skipped.</strong>'
      + (res.problems.length ? '<div class="hint">' + res.problems.map(esc).join('<br>') + '</div>' : '')
      + (res.invited.length
        ? '<div style="margin-top:6px">Passwords to hand over:<br>' +
          res.invited.map((p) => esc(p.name) + ' \u2014 ' + esc(p.username) + ' : <code>' + esc(p.password) + '</code>').join('<br>') + '</div>'
        : '');
    toast('Import finished');
    await loadUsers();
  });
  $('user2faReset').addEventListener('click', async () => {
    if (!state.editing) return;
    const ok = await askConfirm('Reset two-factor?',
      'The next sign-in for ' + state.editing.name + ' uses their password alone until they set it up again.',
      'RESET', 'Reset');
    if (!ok) return;
    await api('/api/admin/users/' + state.editing.id + '/2fa', { method: 'DELETE' });
    toast('Two-factor reset');
    $('userModal').classList.remove('open');
    await loadUsers();
  });
  $('driveQuota').addEventListener('change', async () => {
    const mb = Math.max(50, Math.min(102400, Number($('driveQuota').value) || 1024));
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ driveQuotaMb: mb }) });
    $('driveQuota').value = String(mb);
    toast('Drive quota ' + mb + ' MB per person');
  });
  $('btnAddCanned').addEventListener('click', addCanned);
  $('otrAllowed').addEventListener('change', async (e) => {
    await api('/api/admin/settings', {
      method: 'POST', body: JSON.stringify({ otrAllowed: e.target.checked }),
    });
    toast(e.target.checked ? 'Off-the-record messages allowed' : 'Off-the-record messages disabled');
  });

  $('btnReloadWork').addEventListener('click', loadWork);
  $('btnAddHoliday').addEventListener('click', async () => {
    const day = $('holidayDay').value;
    const name = $('holidayName').value.trim();
    if (!day || !name) return toast('Pick a date and give it a name.');
    try {
      await api('/api/admin/holidays', { method: 'POST', body: JSON.stringify({ day, name }) });
      $('holidayName').value = '';
      toast('Holiday added');
      await loadWork();
    } catch (err) { toast(err.message); }
  });
  $('btnRunReport').addEventListener('click', () => loadHoursReport().catch((err) => toast(err.message)));
  $('btnChatLog').addEventListener('click', () => {
    const { from, to } = reportRange();
    const userId = $('repPerson').value;
    location.href = '/api/reports/chat?from=' + from + '&to=' + to + (userId ? '&userId=' + encodeURIComponent(userId) : '');
  });
  $('repFrom').value = dateInputValue(Date.now() - 13 * 86400000);
  $('repTo').value = dateInputValue(Date.now());

  $('turnSave').addEventListener('click', async () => {
    const keyId = $('turnKeyId').value.trim();
    const token = $('turnApiToken').value.trim();
    if (!keyId) { toast('Paste the TURN key ID first'); return; }
    try {
      await api('/api/admin/settings', {
        method: 'POST',
        // The token is only sent when a new one is typed; otherwise it stays put.
        body: JSON.stringify({ turnKeyId: keyId, ...(token ? { turnApiToken: token } : {}) }),
      });
      $('turnApiToken').value = '';
      toast('Relay saved');
      await loadServer().catch(() => {});
    } catch {
      toast('Could not save the relay');
    }
  });

  $('workHoursSave').addEventListener('click', async () => {
    const days = [...$('workHoursDays').querySelectorAll('input[data-day]')]
      .filter((b) => b.checked).map((b) => b.dataset.day).join(',');
    try {
      await api('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({
          workHours: {
            on: $('workHoursOn').checked,
            from: $('workHoursFrom').value || '09:00',
            to: $('workHoursTo').value || '17:00',
            days,
            note: $('workHoursNote').value.trim(),
          },
        }),
      });
      toast($('workHoursOn').checked ? 'Work hours saved' : 'Work hours off');
      await loadServer().catch(() => {});
    } catch {
      toast('Could not save work hours');
    }
  });

  $('btnBackToChat').addEventListener('click', () => { location.href = '/app'; });
  $('btnAdminLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/login';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('userModal').classList.remove('open');
  });
}

async function boot() {
  wire();
  if (window.initThemePicker) window.initThemePicker();
  try {
    const boot = await api('/api/bootstrap');
    $('adminMe').textContent = boot.me.name + ' · ' + boot.me.role;
    $('adminMe').title = boot.me.email || '';
  } catch { /* the API refuses below if not allowed */ }
  await loadDepartments();
  await loadUsers();
}

boot().catch((err) => {
  console.error(err);
  toast(err.message || 'Could not load the panel');
});

/* ---------------- dynamic DNS ---------------- */

async function loadDdns() {
  try {
    const d = await api('/api/admin/ddns');
    $('ddnsHost').value = d.host || '';
    $('ddnsMode').value = d.mode || 'off';
    $('ddnsUrl').value = d.url || '';
    $('ddnsUser').value = d.user || '';
    $('ddnsPass').value = '';
    $('ddnsPass').placeholder = d.hasPass ? 'saved — leave blank to keep' : 'password or token';
    let line = 'No update sent yet.';
    if (d.lastAt) {
      line = d.result === 'ok'
        ? 'Last update ' + fmtWhen(d.lastAt) + ' → ' + (d.lastIp || '?')
        : 'Last attempt failed ' + fmtWhen(d.lastAt) + ': ' + (d.detail || 'no detail');
    }
    line += d.host ? ' · links use ' + (d.link || 'the address above')
                   : ' · links use ' + (d.publicIp || 'the address above');
    $('ddnsInfo').textContent = line;
  } catch (err) { /* the rest of the panel still works */ }
}

const ddnsSaveBtn = $('btnDdnsSave');
if (ddnsSaveBtn) {
  ddnsSaveBtn.addEventListener('click', async () => {
    ddnsSaveBtn.disabled = true;
    try {
      await api('/api/admin/ddns', {
        method: 'POST',
        body: JSON.stringify({
          host: $('ddnsHost').value.trim(),
          mode: $('ddnsMode').value,
          url: $('ddnsUrl').value.trim(),
          user: $('ddnsUser').value.trim(),
          pass: $('ddnsPass').value,
        }),
      });
      toast('Dynamic DNS saved');
      await loadDdns();
    } catch (err) { toast(err.message || 'Could not save dynamic DNS'); }
    ddnsSaveBtn.disabled = false;
  });
}

const ddnsCheckBtn = $('btnDdnsCheck');
if (ddnsCheckBtn) {
  ddnsCheckBtn.addEventListener('click', async () => {
    ddnsCheckBtn.disabled = true;
    try {
      const r = await api('/api/admin/ddns/check', { method: 'POST' });
      toast(r.ok ? 'Updated: ' + (r.link || r.ip) : 'Update failed: ' + (r.detail || 'unknown'));
      await loadDdns();
    } catch (err) { toast(err.message || 'Could not send the update'); }
    ddnsCheckBtn.disabled = false;
  });
}
