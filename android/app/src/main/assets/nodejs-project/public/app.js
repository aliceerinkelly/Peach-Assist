/* Operator app */
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

const state = {
  me: null,
  modules: null,
  contacts: [],
  people: [],
  groups: [],
  rooms: [],
  departments: [],
  canned: [],
  readers: [],
  activeKind: null,
  activeGroup: false,
  activeUserId: null,
  activeClientId: null,
  activeConvId: null,
  messages: [],
  lastSeq: 0,
  clientReadSeq: 0,
  tab: 'all',
  filter: '',
  ws: null,
  retry: 0,
  typingTimer: null,
  slashIndex: -1,
  slashItems: [],
  galleryMode: false,
  announcements: null,
  activeAnnounce: false,
  otrAllowed: true,
  otrOn: false,
  pendingAck: false,
  pendingAnnounce: false,
  remindersDue: 0,
};

const COLORS = ['#3f7ef7', '#7c4dff', '#e2574c', '#2f9e5f', '#f0a22e', '#0ea5b7', '#d946a0', '#5b6b8c'];

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}
function colorFor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return COLORS[h % COLORS.length];
}
function avatarNode(name, size = '') {
  const n = el('div', 'avatar ' + size);
  n.style.background = colorFor(name);
  n.textContent = initials(name);
  return n;
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function fmtShort(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtTime(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json', ...(opts.headers || {}) } : (opts.headers || {}),
    ...opts,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/* ---------------- contacts ---------------- */

function visibleContacts() {
  let list = state.contacts.slice();
  if (state.tab === 'archived') list = list.filter((c) => c.archived);
  else list = list.filter((c) => !c.archived);
  if (state.tab === 'unread') list = list.filter((c) => c.unread > 0);

  list.sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.lastAt - a.lastAt);
  return list;
}

/** Throw away whatever is in the search box, typed or autofilled. */
function resetFilterOnBoot() {
  const box = $('filterInput');
  if (box && box.value) box.value = '';
  state.filter = '';
  closeSearchBubble();
}

function clearFilter() {
  const box = $('filterInput');
  if (box) box.value = '';
  state.filter = '';
  closeSearchBubble();
}

/* ---------------- comic speech bubbles ---------------- */

/** The last sentence of a preview, the way a speech bubble would say it. */
function lastSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/([^.!?]*[.!?])\s*$/);
  const s = m ? m[1].trim() : t;
  return s.length > 160 ? s.slice(0, 157).replace(/\s+\S*$/, '') + '\u2026' : s;
}

/** What the bubble under a row should say when there is no last message yet. */
function bubbleSummary(kind, item) {
  if (item.lastMessage) return lastSentence(item.lastMessage) || item.lastMessage;
  if (kind === 'room' || kind === 'group') {
    const m = Number(item.members) || 0;
    return m + (m === 1 ? ' member so far' : ' members so far');
  }
  if (kind === 'client') return item.status === 'Invited' ? 'Invite not opened yet' : 'No messages yet';
  return [item.status, item.statusText].filter(Boolean).join(' \u00b7 ') || 'No messages yet';
}

/** Build one comic bubble: a name, a kind tag, and the last thing said. */
function comicNode(info) {
  const b = el('div', 'cb' + (info.up ? ' cb-up' : ''));
  const head = el('div', 'cb-head');
  const named = (info.kind === 'room' || info.kind === 'group') ? '#' + info.name : info.name;
  // textContent, not innerHTML: these strings are other people's words.
  const nameEl = el('span', 'cb-name');
  nameEl.textContent = named;
  head.appendChild(nameEl);
  const tagText = { room: 'room', group: 'group', person: 'person', client: 'client' }[info.kind] || 'search';
  head.appendChild(el('span', 'cb-tag', tagText));
  b.appendChild(head);
  const said = el('div', 'cb-said');
  said.textContent = info.text;
  b.appendChild(said);
  if (info.unread > 0) b.appendChild(el('div', 'cb-unread', info.unread + ' unread'));
  return b;
}

/** Hovering a row opens a bubble beside it with the last sentence of that chat. */
function rowBubbleFor(row, item, kind) {
  const text = bubbleSummary(kind, item);
  if (!text) return;
  const info = { name: item.name, text, kind, unread: Number(item.unread) || 0 };
  row.addEventListener('mouseenter', () => showRowBubble(row, info));
  row.addEventListener('mouseleave', hideRowBubble);
  row.addEventListener('focus', () => showRowBubble(row, info));
  row.addEventListener('blur', hideRowBubble);
}

function showRowBubble(anchor, info) {
  const host = $('rowBubble');
  if (!host) return;
  host.innerHTML = '';
  host.appendChild(comicNode(info));
  host.hidden = false;
  host.style.visibility = 'hidden';
  host.style.left = '0px';
  host.style.top = '0px';

  const r = anchor.getBoundingClientRect();
  const bw = host.offsetWidth;
  const bh = host.offsetHeight;
  let side = 'right';
  let left = r.right + 12;
  if (left + bw > window.innerWidth - 10) {
    left = r.left - bw - 12;
    side = 'left';
  }
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  let top = r.top + r.height / 2 - bh / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - bh - 8));

  host.dataset.side = side;
  host.style.left = left + 'px';
  host.style.top = top + 'px';
  host.style.visibility = '';
}

function hideRowBubble() {
  const host = $('rowBubble');
  if (!host || host.hidden) return;
  host.hidden = true;
  host.innerHTML = '';
}

/** Matches for the search box, grouped the way the sidebar is. */
function searchMatches(q) {
  const f = q.trim().toLowerCase();
  if (!f) return [];
  const hit = (o) => [o.name, o.lastMessage, o.statusText, o.email]
    .some((v) => String(v || '').toLowerCase().includes(f));
  return [
    { kind: 'room', label: 'Rooms', items: state.rooms.filter(hit) },
    { kind: 'person', label: 'People', items: state.people.filter(hit) },
    { kind: 'group', label: 'Groups', items: state.groups.filter(hit) },
    { kind: 'client', label: 'Clients', items: state.contacts.filter(hit) },
  ].filter((g) => g.items.length);
}

function openSearchResult(kind, item) {
  if (kind === 'room') {
    openConversation({ conversationId: item.conversationId, name: item.name, kind: 'room', status: 'Room', members: item.members });
  } else if (kind === 'group') {
    openConversation({ conversationId: item.conversationId, name: item.name, kind: 'group', members: item.members, status: (item.members || 0) + ' members' });
  } else if (kind === 'person') {
    if (item.dmId) {
      openConversation({ conversationId: item.dmId, name: item.name, kind: 'dm', userId: item.userId, status: item.status, statusText: item.statusText });
    } else {
      startDM(item);
    }
  } else {
    openConversation(item);
  }
  clearFilter();
}

/** Typing shows bubbles with the hits; the sidebar list itself never changes. */
function renderSearchBubble() {
  const host = $('searchBubble');
  if (!host) return;
  const q = state.filter.trim();
  if (!q) { closeSearchBubble(); return; }

  host.innerHTML = '';
  host.hidden = false;
  host.appendChild(el('div', 'sb-cap', 'Matches for \u201c' + q + '\u201d'));

  const groups = searchMatches(q);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) {
    host.appendChild(comicNode({ name: 'No matches', text: 'Nothing here is called \u201c' + q + '\u201d.', kind: 'search', up: true }));
    host.lastChild.classList.add('cb-none');
    return;
  }

  let shown = 0;
  for (const g of groups) {
    for (const item of g.items) {
      if (shown >= 5) break;
      shown++;
      const node = comicNode({ name: item.name, text: bubbleSummary(g.kind, item), kind: g.kind, up: true });
      node.classList.add('cb-hit');
      node.addEventListener('click', () => openSearchResult(g.kind, item));
      host.appendChild(node);
    }
    if (shown >= 5) break;
  }
  if (total > shown) host.appendChild(el('div', 'sb-more', '+' + (total - shown) + ' more \u2014 keep typing'));
}

function closeSearchBubble() {
  const host = $('searchBubble');
  if (!host) return;
  host.hidden = true;
  host.innerHTML = '';
}

function renderContacts() {
  const host = $('contacts');
  host.innerHTML = '';
  const list = visibleContacts();

      // People who are offline drop out of the list; a row only stays if it is
    // holding unread messages, so nothing can be missed just because someone left.
    const people = state.tab === 'archived' ? [] :
      state.people.filter((p) => (state.tab !== 'unread' || p.unread > 0) &&
        (p.status !== 'Offline' || p.unread > 0));
  const groups = state.tab === 'archived' ? [] :
    state.groups.filter((g) => (state.tab !== 'unread' || g.unread > 0));

  people.sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.lastAt - a.lastAt || a.name.localeCompare(b.name));

  if (people.length || (state.people.length && state.tab !== 'archived')) {
    const head = el('div', 'group-head');
    head.innerHTML = '<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m6 9 6 6 6-6"/></svg>' +
      `<span>People</span><span class="count">(${people.length})</span>`;
    host.appendChild(head);
    for (const p of people) host.appendChild(personRow(p));
  }

  // The + that starts a group lives in this header, so the header has to exist
  // even when there are no groups yet. It used to be built only when a group
  // already existed, which meant a new account had no way to make the first
  // one — and on the phone the desktop header button is hidden by the narrow
  // screen rules, so there was no + anywhere at all.
  if (state.tab !== 'archived') {
    const head = el('div', 'group-head');
    head.innerHTML = '<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m6 9 6 6 6-6"/></svg>' +
      `<span>Groups</span><span class="count">(${groups.length})</span>` +
      '<button class="room-add" id="btnNewGroup2" title="New group" aria-label="New group">+</button>';
    host.appendChild(head);
    head.querySelector('#btnNewGroup2').addEventListener('click', newGroup);
    if (!groups.length) {
      host.appendChild(el('div', 'empty-list',
        'No groups yet \u2014 tap + to start one.'));
    }
    groups.sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.lastAt - a.lastAt);
    for (const g of groups) host.appendChild(personRow(g, true));
  }

  // Rooms are a different thing from groups — open rooms anyone can walk into —
  // so they get their own header and their own +, in amber, never the groups'
  // blue one. Previously rooms were reachable only by typing /list.
  if (state.tab !== 'archived' && state.tab !== 'unread') {
    const rooms = state.rooms.slice();
    const head = el('div', 'group-head');
    head.innerHTML = '<span>Rooms</span><span class="count">(' + rooms.length + ')</span>' +
      '<button class="room-add room-add-rooms" id="btnNewRoom2" title="New room" aria-label="New room">+</button>';
    host.appendChild(head);
    head.querySelector('#btnNewRoom2').addEventListener('click', newRoom);
    for (const r of rooms) host.appendChild(roomRow(r));
    const browse = el('button', 'room-browse', rooms.length ? 'Browse all rooms\u2026' : 'No rooms yet \u2014 tap + to make one');
    browse.type = 'button';
    browse.addEventListener('click', async () => {
      const res = await api('/api/command', {
        method: 'POST',
        body: JSON.stringify({ text: '/list', conversationId: state.activeConvId }),
      }).catch(() => null);
      if (res && res.rooms) openRoomList(res.rooms);
      else toast((res && res.error) || 'Could not list the rooms');
    });
    host.appendChild(browse);
  }

      // Rooms are deliberately not listed here: /list opens the searchable picker.


      if (!list.length) {
      if (people.length || groups.length) return;
      host.appendChild(el('div', 'empty-list',
        state.people.length ? 'Nobody else is online right now.' :
          'Nobody else is here yet. An administrator can add people in the admin panel.'));
      return;
    }

  const label = state.tab === 'archived' ? 'Archived' : 'Clients';
  const head = el('div', 'group-head');
  head.innerHTML = `<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m6 9 6 6 6-6"/></svg>
    <span>${label}</span><span class="count">(${list.length})</span>`;
  host.appendChild(head);

  for (const c of list) {
    const row = el('div', 'contact' + (c.conversationId === state.activeConvId ? ' active' : ''));
    row.dataset.clientId = c.clientId;

    const av = avatarNode(c.name);
    const dot = el('span', 'online-dot' + (c.status === 'Online' ? '' : ' off'));
    av.appendChild(dot);

    const body = el('div', 'body');
    body.innerHTML = `
      <div class="row1">
        <div class="cname">${esc(c.name)}</div>
        <div class="time">${c.lastAt ? esc(fmtShort(c.lastAt)) : ''}</div>
      </div>
      <div class="row2">
        <span class="presence-dot" style="background:${c.status === 'Online' ? 'var(--green)' : c.status === 'Invited' ? 'var(--amber)' : '#b9c4d0'}"></span>
        <span class="preview">${esc(c.lastMessage || (c.status === 'Invited' ? 'Invite not opened yet' : 'No messages yet'))}</span>
      </div>`;

    row.append(av, body);
    if (c.unread > 0) row.appendChild(el('div', 'unread', String(c.unread)));
    rowBubbleFor(row, c, 'client');
    row.addEventListener('click', () => openConversation(c));
    host.appendChild(row);
  }
}

/** One sidebar row for a colleague or a group. */
/**
 * A room row. Rooms are not people, so they cannot borrow personRow: that one
 * prints a presence status and reads a DM id, which rooms have neither of —
 * the row came out reading "undefined" and tapping it tried to start a new DM.
 */
function roomRow(item) {
  const row = el('div', 'contact room' + (item.conversationId === state.activeConvId ? ' active' : ''));
  const av = avatarNode(item.name);
  av.style.background = 'var(--amber)';
  av.style.color = '#fff';
  av.textContent = '#';

  const members = Number(item.members) || 0;
  const body = el('div', 'body');
  body.innerHTML = `
    <div class="row1"><div class="cname">${esc(item.name)}</div><div class="time">${item.lastAt ? esc(fmtShort(item.lastAt)) : ''}</div></div>
    <div class="row2">
      <span class="presence-dot" style="background:var(--amber)"></span>
      <span class="preview">${esc(item.lastMessage || (members + (members === 1 ? ' member' : ' members')))}</span>
    </div>`;
  row.append(av, body);
  if (item.unread > 0) row.appendChild(el('div', 'unread', String(item.unread)));
  rowBubbleFor(row, item, 'room');

  row.addEventListener('click', () => openConversation({
    conversationId: item.conversationId,
    name: item.name,
    kind: 'room',
    status: 'Room',
    members,
  }));
  return row;
}

function personRow(item, isGroup) {
  const row = el('div', 'contact' + (item.conversationId && item.conversationId === state.activeConvId ? ' active' : ''));
  const av = avatarNode(item.name);
  if (isGroup) {
    av.style.background = 'var(--accent)';
    av.textContent = '#';
  } else {
    av.appendChild(el('span', 'online-dot' + (item.status === 'Online' ? '' : ' off')));
  }

  const colour = item.status === 'Online' ? 'var(--green)' :
    item.status === 'Busy' ? 'var(--red)' :
      item.status === 'Offline' ? '#b9c4d0' : 'var(--amber)';
  const sub = isGroup
    ? `${item.members || 0} member${item.members === 1 ? '' : 's'}`
    : item.status + (item.statusText ? ' · ' + item.statusText : '');

  const body = el('div', 'body');
  body.innerHTML = `
    <div class="row1"><div class="cname">${esc(item.name)}</div><div class="time">${item.lastAt ? esc(fmtShort(item.lastAt)) : ''}</div></div>
    <div class="row2">
      <span class="presence-dot" style="background:${isGroup ? 'var(--accent)' : colour}"></span>
      <span class="preview">${esc(item.lastMessage || sub)}</span>
    </div>`;
  row.append(av, body);
  if (item.unread > 0) row.appendChild(el('div', 'unread', String(item.unread)));
  rowBubbleFor(row, item, isGroup ? 'group' : 'person');

  row.addEventListener('click', () => {
    if (isGroup) {
      openConversation({
        conversationId: item.conversationId, name: item.name, kind: 'group',
        members: item.members, status: item.members + ' members',
      });
    } else if (item.dmId) {
      openConversation({
        conversationId: item.dmId, name: item.name, kind: 'dm', userId: item.userId,
        status: item.status, statusText: item.statusText,
      });
    } else {
      startDM(item);
    }
  });
  return row;
}

/** Open (or create) the private chat with a colleague. */
async function startDM(person) {
  try {
    const res = await api('/api/dm', { method: 'POST', body: JSON.stringify({ userId: person.userId }) });
    person.dmId = res.conversationId;
    openConversation({
      conversationId: res.conversationId, name: person.name, kind: 'dm',
      userId: person.userId, status: person.status, statusText: person.statusText,
    });
  } catch {
    toast('Could not open that chat');
  }
}

/* ---------------- chat ---------------- */

function openConversation(contact) {
  state.activeKind = contact.kind || 'client';
  state.activeRoom = state.activeKind === 'room';
  state.activeGroup = state.activeKind === 'group';
  state.activeAnnounce = state.activeKind === 'announce';
  state.activeClientId = contact.clientId || null;
  state.activeUserId = contact.userId || null;
  state.activeConvId = contact.conversationId;
  // Off-the-record and next-message flags belong to the chat you just left.
  state.pendingAck = false;
  state.pendingAnnounce = false;
  state.otrOn = false;
  updateComposerChips();
  state.messages = [];
  state.lastSeq = 0;
  state.clientReadSeq = 0;
  state.readers = [];
  state.galleryMode = false;

  $('chatEmpty').style.display = 'none';
  $('chatMain').style.display = 'flex';
  $('shell').classList.add('show-chat');

  $('chatName').textContent = contact.name;
  const sub = state.activeAnnounce
    ? (state.me && state.me.admin ? 'Team-wide · you can post' : 'Team-wide · administrators post here')
    : state.activeRoom
    ? (contact.members ? contact.members + ' joined · open room' : 'Open room · share the link')
    : state.activeGroup
      ? (contact.members || 0) + ' members'
      : (contact.status || 'Offline') + (contact.statusText ? ' · ' + contact.statusText : '');
  $('chatStatus').textContent = sub;
  $('btnNotes').style.display = state.activeKind === 'client' ? '' : 'none';
  $('btnMembers').hidden = !state.activeGroup;
  $('notesDrawer').classList.remove('open');
  $('chatDot').style.background = state.activeGroup ? 'var(--accent)' :
    contact.status === 'Online' ? 'var(--green)' :
      contact.status === 'Busy' ? 'var(--red)' : '#b9c4d0';
  const av = $('chatAvatar');
  av.textContent = initials(contact.name);
  av.style.background = colorFor(contact.name);

  switchHeadTab('chat');
  // Only administrators can write into the announcements thread.
  const readOnly = state.activeAnnounce && !(state.me && state.me.admin);
  $('composer').style.display = readOnly ? 'none' : 'flex';
  renderContacts();
  loadMessages(0);
  if (state.activeKind === 'client') loadNotes(contact.clientId);
  $('composerInput').focus();
}

function switchHeadTab(which) {
  state.galleryMode = which === 'images';
  document.querySelectorAll('.head-tab').forEach((b) => b.classList.toggle('active', b.dataset.htab === which));
  $('messages').style.display = which === 'chat' ? 'flex' : 'none';
  $('composer').style.display = which === 'chat' ? 'flex' : 'none';
  $('gallery').style.display = which === 'images' ? 'grid' : 'none';
  if (which === 'images') loadGallery();
}

async function loadMessages(since) {
  if (!state.activeConvId) return;
  const data = await api(`/api/conversations/${state.activeConvId}/messages?since=${since}&limit=300`);
  if (since === 0) state.messages = data.messages;
  else state.messages = state.messages.concat(data.messages);
  if (typeof data.peerReadSeq === 'number') state.clientReadSeq = data.peerReadSeq;
  if (Array.isArray(data.readers)) state.readers = data.readers;
  if (data.messages.length) state.lastSeq = Math.max(state.lastSeq, data.messages[data.messages.length - 1].seq);
  renderMessages();
  markRead();
}

/* In a group a message counts as read once every other member has seen it. */
function peerReadSeq() {
  const others = (state.readers || []).filter((r) => !state.me || r.userId !== state.me.id);
  if (!others.length) return state.clientReadSeq;
  return Math.min(...others.map((r) => r.seq || 0));
}

function ticksNode(msg) {
  const seen = msg.seq <= peerReadSeq();
  const span = el('span', 'ticks' + (seen ? ' seen' : ''));
  span.innerHTML = seen
    ? '<svg viewBox="0 0 24 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m1 9 4 4 8-9"/><path d="m9 13 8-9"/></svg>'
    : '<svg viewBox="0 0 24 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 4 4 8-9"/></svg>';
  return span;
}

function attachmentCard(att, mine) {
  const card = el('div', 'attach-card');
  const isImg = (att.mime || '').startsWith('image/');
  const isAudio = (att.mime || '').startsWith('audio/');
  const ext = (att.filename.split('.').pop() || '').toUpperCase().slice(0, 4);
  const iconCls = isImg ? 'img' : att.mime === 'application/pdf' ? 'pdf' : 'doc';

  if (isAudio) {
    card.classList.add('voice');
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = att.url;
    const meta = el('div', 'vmeta');
    meta.innerHTML = `<span class="voice-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg></span>
      <span>Voice message</span><span class="vdur">${esc(fmtDur(att.durationMs))}</span>`;
    card.appendChild(meta);
    card.appendChild(audio);
    return card;
  }

  if (isImg) {
    card.classList.add('image');
    const a = el('a');
    a.href = att.url; a.target = '_blank'; a.rel = 'noopener';
    const img = el('img');
    img.src = att.url;
    img.alt = att.filename;
    img.loading = 'lazy';
    a.appendChild(img);
    card.appendChild(a);
    const info = el('div', 'finfo');
    info.innerHTML = `<div class="fname">${esc(att.filename)}</div><div class="fsize">${esc(fmtBytes(att.bytes))}</div>`;
    card.appendChild(info);
    return card;
  }

  const a = el('a');
  a.href = att.url; a.target = '_blank'; a.rel = 'noopener';
  a.innerHTML = `<div class="ficon ${iconCls}">${esc(ext || 'FILE')}</div>
    <div class="finfo"><div class="fname">${esc(att.filename)}</div>
    <div class="fsize">${esc(fmtBytes(att.bytes))}</div></div>`;
  card.appendChild(a);
  return card;
}

/* A poll renders as a card: bars, counts and one click to answer. */
function pollCard(m) {
  const p = m.poll;
  const myId = state.me && state.me.id;
  const mine = new Set();
  for (const o of p.options) for (const v of o.voters) if (v.userId === myId) mine.add(o.id);

  const card = el('div', 'poll-card');
  card.appendChild(el('div', 'poll-q', esc(p.question)));
  const list = el('div', 'poll-options');
  for (const o of p.options) {
    const pct = p.voters ? Math.round((o.votes / p.voters) * 100) : 0;
    const voted = mine.has(o.id);
    const btn = el('button', 'poll-opt-row' + (voted ? ' voted' : '') + (p.closed ? ' closed' : ''));
    btn.innerHTML = `<span class="bar" style="width:${pct}%"></span>
      <span class="lab">${voted ? '✓ ' : ''}${esc(o.label)}</span>
      <span class="cnt">${o.votes}</span>`;
    if (o.voters.length) btn.title = o.voters.map((v) => v.name).join(', ');
    if (!p.closed) btn.addEventListener('click', () => votePoll(p.id, o.id));
    list.appendChild(btn);
  }
  card.appendChild(list);

  const foot = el('div', 'poll-foot');
  foot.appendChild(el('span', '', `${p.voters} ${p.voters === 1 ? 'person' : 'people'} answered${p.multi ? ' · multiple answers allowed' : ''}`));
  if (p.closed) {
    foot.appendChild(el('span', 'poll-closed', 'Closed'));
  } else if (myId && (p.createdBy === myId || (state.me && state.me.admin))) {
    const close = el('button', 'link-danger', 'Close poll');
    close.addEventListener('click', () => closePoll(p.id));
    foot.appendChild(close);
  }
  card.appendChild(foot);
  return card;
}

function ackBar(m) {
  const myId = state.me && state.me.id;
  const acks = m.acks || [];
  const bar = el('div', 'ack-bar');
  const names = acks.map((a) => a.name).join(', ');
  const iAcked = acks.some((a) => a.userId === myId);

  if (m.senderId !== myId && !iAcked) {
    const b = el('button', 'btn small primary', 'Acknowledge');
    b.addEventListener('click', () => acknowledge(m.id));
    bar.appendChild(b);
    if (names) bar.appendChild(el('span', 'ack-count', names + ' acknowledged'));
    else bar.appendChild(el('span', 'ack-count', 'Waiting for everyone'));
    return bar;
  }

  bar.appendChild(el('span', 'ack-count', names
    ? 'Acknowledged by ' + names
    : 'No acknowledgements yet'));
  return bar;
}

async function votePoll(pollId, optionId) {
  try {
    const res = await api(`/api/polls/${pollId}/vote`, {
      method: 'POST', body: JSON.stringify({ optionId }),
    });
    const m = state.messages.find((x) => x.poll && x.poll.id === pollId);
    if (m && res.poll) { m.poll = res.poll; renderMessages(); }
  } catch {
    toast('Could not record your answer');
  }
}

async function closePoll(pollId) {
  try {
    await api(`/api/polls/${pollId}/close`, { method: 'POST' });
  } catch {
    toast('Could not close the poll');
  }
}

async function acknowledge(messageId) {
  try {
    const res = await api(`/api/messages/${messageId}/ack`, { method: 'POST' });
    const m = state.messages.find((x) => x.id === messageId);
    if (m && res.acks) { m.acks = res.acks; renderMessages(); }
    toast('Acknowledged');
  } catch {
    toast('Could not acknowledge');
  }
}

function renderMessages() {
  const host = $('messages');
  host.innerHTML = '';
  if (!state.messages.length) {
    const e = el('div', 'empty-list', 'No messages yet. Say hello.');
    e.style.alignSelf = 'center';
    host.appendChild(e);
    return;
  }

  let lastDay = '';
  let prevSender = '';
  let prevTime = 0;
  const myId = state.me && state.me.id;

  for (const m of state.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (lastDay && day !== lastDay) {
      host.appendChild(el('div', 'date-sep', esc(fmtDay(m.createdAt))));
    }
    lastDay = day;

    const mine = m.senderType === 'operator' && m.senderId === myId;
    const who = m.senderId || m.senderType;
    const grouped = who === prevSender && Math.abs(m.createdAt - prevTime) < 5 * 60000;
    prevSender = who;
    prevTime = m.createdAt;

    const row = el('div', 'msg-row' + (mine ? ' mine' : '') + (grouped ? ' grouped' : ' first'));
    const gutter = el('div', 'gutter');
    if (!grouped && !mine) {
      const av = avatarNode(m.senderName, 'sm');
      gutter.appendChild(av);
    }
    row.appendChild(gutter);

    const wrap = el('div', 'bubble-wrap');
    if (!grouped && !mine) {
      const line = el('div', 'sender-line');
      line.innerHTML = `${esc(m.senderName)} <span class="t">${esc(fmtTime(m.createdAt))}</span>`;
      wrap.appendChild(line);
    }

    if (m.kind === 'poll' && m.poll) {
      wrap.appendChild(pollCard(m));
      row.appendChild(wrap);
      host.appendChild(row);
      continue;
    }

    const hasText = m.kind === 'text' || !m.attachment || !!m.body;
    if (hasText) {
      const bubble = el('div', 'bubble' +
        (m.pending ? ' pending' : '') +
        (m.kind === 'announcement' ? ' announcement' : '') +
        (m.kind === 'auto' ? ' auto' : '') +
        (m.kind === 'otr' ? ' otr' : '') +
        (m.kind === 'call' ? ' calllog' : '') +
        (m.kind === 'ack' ? ' ask' : ''));
      const tag = m.kind === 'announcement' ? '<span class="kindtag">Announcement</span>'
        : m.kind === 'auto' ? '<span class="kindtag">Automatic reply</span>'
          : m.kind === 'otr' ? '<span class="kindtag">Off the record</span>'
            : '';
      bubble.innerHTML = tag + esc(m.body || '');
      // Received messages show the time in the sender line; stamp only our own
      // bubbles and grouped received ones, which have no sender line.
      if (mine || grouped) {
        const stamp = el('span', 'stamp');
        stamp.textContent = fmtTime(m.createdAt);
        if (mine) stamp.appendChild(ticksNode(m));
        bubble.appendChild(stamp);
      }
      wrap.appendChild(bubble);
    }

    if (m.kind === 'ack') wrap.appendChild(ackBar(m));

    if (m.attachment) {
      const card = attachmentCard(m.attachment, mine);
      if (!hasText) {
        const foot = el('div', 'card-foot');
        foot.textContent = fmtTime(m.createdAt);
        if (mine) foot.appendChild(ticksNode(m));
        card.appendChild(foot);
      }
      wrap.appendChild(card);
    }

    row.appendChild(wrap);
    host.appendChild(row);
  }

  host.scrollTop = host.scrollHeight;
  updateRailBadge();
}

function updateRailBadge() {
  const total = state.contacts.concat(state.people, state.groups, state.rooms)
    .reduce((n, c) => n + (c.unread || 0), 0) + ((state.announcements && state.announcements.unread) || 0);
  const dot = $('railUnread');
  dot.hidden = total === 0;
  document.title = total > 0 ? `(${total}) Messenger` : 'Messenger';
}

function markRead() {
  if (!state.activeConvId || !state.lastSeq) return;
  let changed = false;
  for (const list of [state.contacts, state.groups, state.rooms]) {
    for (const item of list) {
      if (item.conversationId === state.activeConvId && item.unread) { item.unread = 0; changed = true; }
    }
  }
  for (const p of state.people) {
    if (p.dmId === state.activeConvId && p.unread) { p.unread = 0; changed = true; }
  }
  if (state.announcements && state.announcements.conversationId === state.activeConvId && state.announcements.unread) {
    state.announcements.unread = 0;
    $('announceUnread').hidden = true;
    changed = true;
  }
  if (changed) { renderContacts(); updateRailBadge(); }
  wsSend({ t: 'read', conversationId: state.activeConvId, seq: state.lastSeq });
  api(`/api/conversations/${state.activeConvId}/read`, {
    method: 'POST',
    body: JSON.stringify({ seq: state.lastSeq }),
  }).catch(() => {});
}

/* ---------------- send ---------------- */

let msgCounter = 0;
function newClientMsgId() {
  msgCounter += 1;
  return 'c' + Date.now().toString(36) + '-' + msgCounter;
}

async function sendMessage() {
  const input = $('composerInput');
  const text = input.value.trim();
  if (!text || !state.activeConvId) return;

  if (/^\/clear$/i.test(text)) {
    input.value = '';
    autosize(input);
    closeSlash();
    clearThread();
    return;
  }

  // Slash commands are resolved by the server, which decides which ones exist.
  if (text.startsWith('/')) {
    const res = await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({ text, conversationId: state.activeConvId }),
    }).catch(() => null);
    if (res && res.ok) {
      input.value = '';
      autosize(input);
      closeSlash();
      if (res.refresh) await refresh();
              if (res.rooms) { openRoomList(res.rooms); return; }
        if (res.openConversationId) openByConversationId(res.openConversationId);
        if (res.message) toast(res.message);
        return;
    }
  }

  // Off the record: the server relays it and keeps nothing.
  if (state.otrOn && state.activeKind !== 'client') {
    input.value = '';
    autosize(input);
    closeSlash();
    try {
      const res = await api(`/api/conversations/${state.activeConvId}/otr`, {
        method: 'POST', body: JSON.stringify({ body: text }),
      });
      if (res && res.error) toast(res.error);
    } catch {
      toast('Off-the-record message failed');
    }
    return;
  }

  input.value = '';
  autosize(input);
  closeSlash();

  const clientMsgId = newClientMsgId();
  const optimistic = {
    id: 'tmp-' + clientMsgId,
    conversationId: state.activeConvId,
    seq: (state.messages[state.messages.length - 1]?.seq || 0) + 0.001,
    senderType: 'operator',
    senderId: state.me.id,
    senderName: state.me.name,
    body: text,
    kind: 'text',
    createdAt: Date.now(),
    attachment: null,
    pending: true,
    clientMsgId,
  };
  state.messages.push(optimistic);
  renderMessages();

  try {
    const res = await api(`/api/conversations/${state.activeConvId}/send`, {
      method: 'POST',
      body: JSON.stringify({
        body: text, clientMsgId,
        requireAck: state.pendingAck,
        announce: state.pendingAnnounce,
      }),
    });
    if (res?.ok) {
      reconcile(res.message);
      state.pendingAck = false;
      state.pendingAnnounce = false;
      updateComposerChips();
    } else if (res?.error) {
      toast(res.error);
    }
  } catch {
    const idx = state.messages.findIndex((m) => m.clientMsgId === clientMsgId);
    if (idx >= 0) state.messages.splice(idx, 1);
    renderMessages();
    toast('Message failed to send');
  }
}

async function clearThread() {
  if (!state.activeConvId) return;
  const ok = await askConfirm(
    'Clear this conversation?',
    'Every message and attached file is deleted for you and the client. The client and their link stay. There is no undo.',
    'CLEAR',
    'Clear chat'
  );
  if (!ok) return;
  const convId = state.activeConvId;
  try {
    await api(`/api/operator/conversations/${convId}/messages`, {
      method: 'DELETE', body: JSON.stringify({ confirm: true }),
    });
  } catch {
    toast('Could not clear the conversation');
    return;
  }
  if (state.activeConvId !== convId) return;
  state.messages = [];
  state.lastSeq = 0;
  const contact = state.contacts.find((c) => c.conversationId === convId);
  if (contact) { contact.unread = 0; contact.preview = ''; contact.lastAt = 0; }
  renderMessages();
  renderContacts();
  toast('Conversation cleared');
}

function reconcile(message) {
  if (!message) return;
  const idx = state.messages.findIndex((m) =>
    (m.clientMsgId && message.clientMsgId && m.clientMsgId === message.clientMsgId) || m.id === message.id);
  if (idx >= 0) state.messages[idx] = message;
  else state.messages.push(message);
  state.lastSeq = Math.max(state.lastSeq, message.seq);
  state.messages.sort((a, b) => a.seq - b.seq);
  renderMessages();
}

/* ---------------- attachments ---------------- */

async function uploadFile(file, opts = {}) {
  const convId = opts.conversationId || state.activeConvId;
  if (!file || !convId) return false;
  const input = $('composerInput');
  const clientMsgId = newClientMsgId();
  if (!opts.quiet) toast('Uploading ' + file.name + '…');

  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Filename': encodeURIComponent(file.name),
    'X-Client-Msg-Id': clientMsgId,
  };
  if (opts.kind) headers['X-Kind'] = opts.kind;
  if (opts.durationMs) headers['X-Duration-Ms'] = String(Math.round(opts.durationMs));

  try {
    const res = await fetch(`/api/conversations/${convId}/upload`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: file,
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Upload failed'); return false; }
    reconcile(data.message);
    input.value = '';
    return true;
  } catch {
    toast('Upload failed');
    return false;
  }
}

/** "1:04" for a duration in milliseconds. */
function fmtDur(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* ---------------- websocket ---------------- */

function setConn(ok) {
  const c = $('conn');
  c.classList.toggle('ok', ok);
  c.classList.toggle('bad', !ok);
  $('connText').textContent = ok ? 'Live' : 'Reconnecting';
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.retry = 0;
    setConn(true);
    // catch up anything missed while disconnected
    if (state.activeConvId) loadMessages(state.lastSeq);
  };

  ws.onclose = () => {
    setConn(false);
    const delay = Math.min(15000, 500 * Math.pow(2, state.retry++));
    setTimeout(connectWS, delay);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.t && (msg.t.startsWith('call:') || msg.t === 'rtc:signal')) {
      handleCallSocket(msg);
      return;
    }

    if (msg.t && handleWorkSocket(msg)) return;
    if (msg.t === 'modules') {
      state.modules = msg.modules || null;
      applyModules();
      toast('Available features were updated');
      return;
    }
    if (msg.t && handlePhase5Socket(msg)) return;

    if (msg.t === 'message') {
      const incoming = msg;
      const isMine = incoming.senderType === 'operator' && incoming.senderId === (state.me && state.me.id);
      if (incoming.conversationId === state.activeConvId) {
        reconcile(incoming);
        if (!isMine) markRead();
      }
      const preview = incoming.kind === 'text' || incoming.kind === 'call'
        ? incoming.body
        : incoming.kind === 'voice' ? 'Attachment'
          : '[' + (incoming.kind || 'file') + '] ' + (incoming.attachment?.filename || '');
      const bump = (item) => {
        if (!item) return;
        item.lastMessage = preview;
        item.lastAt = incoming.createdAt;
        if (incoming.conversationId !== state.activeConvId && !isMine) item.unread = (item.unread || 0) + 1;
      };
      if (state.announcements && incoming.conversationId === state.announcements.conversationId) {
        state.announcements.lastMessage = preview;
        state.announcements.lastAt = incoming.createdAt;
        if (incoming.conversationId !== state.activeConvId && !isMine) {
          state.announcements.unread = (state.announcements.unread || 0) + 1;
        }
        $('announcePreview').textContent = preview;
        $('announceUnread').hidden = !state.announcements.unread;
        $('announceUnread').textContent = String(state.announcements.unread || '');
        updateRailBadge();
      }
      bump(state.contacts.find((c) => c.conversationId === incoming.conversationId));
      bump(state.people.find((p) => p.dmId === incoming.conversationId));
      bump(state.groups.find((g) => g.conversationId === incoming.conversationId));
      bump(state.rooms.find((r) => r.conversationId === incoming.conversationId));
      renderContacts();
      return;
    }

    if (msg.t === 'wall') {
      const wm = $('wallModal');
      if (wm && wm.classList.contains('open')) loadWall().catch(() => {});
      return;
    }

    if (msg.t === 'refresh') {
      refresh().catch(() => {});
      return;
    }

    if (msg.t === 'cleared') {
      if (msg.conversationId === state.activeConvId) {
        state.messages = [];
        state.lastSeq = 0;
        renderMessages();
      }
      return;
    }

    if (msg.t === 'read') {
      if (msg.conversationId !== state.activeConvId) return;
      const seq = Number(msg.seq || 0);
      if (msg.by === 'client') {
        state.clientReadSeq = Math.max(state.clientReadSeq, seq);
      } else if (msg.userId && msg.userId !== (state.me && state.me.id)) {
        const r = state.readers.find((x) => x.userId === msg.userId);
        if (r) r.seq = Math.max(r.seq, seq);
        else state.readers.push({ userId: msg.userId, name: msg.name || 'Member', seq });
        if (state.activeKind === 'dm') state.clientReadSeq = Math.max(state.clientReadSeq, seq);
      }
      renderMessages();
      return;
    }

    if (msg.t === 'typing') {
      if (msg.conversationId !== state.activeConvId) return;
      // Our own typing is echoed back; only show somebody else's.
      const fromMe = msg.by === 'operator' && msg.userId === (state.me && state.me.id);
      if (!fromMe) showTyping(msg.name || 'Someone');
      return;
    }

    if (msg.t === 'poll' && msg.messageId) {
      const m = state.messages.find((x) => x.id === msg.messageId);
      if (m) { m.poll = msg.poll; renderMessages(); }
      return;
    }

    if (msg.t === 'ack' && msg.messageId) {
      const m = state.messages.find((x) => x.id === msg.messageId);
      if (m) { m.acks = msg.acks; renderMessages(); }
      return;
    }

    if (msg.t === 'otr') {
      if (msg.conversationId !== state.activeConvId) return;
      reconcile({
        id: msg.id,
        conversationId: msg.conversationId,
        seq: (state.lastSeq || 0) + 0.002,
        senderType: 'operator',
        senderId: msg.senderId,
        senderName: msg.senderName,
        body: msg.body,
        kind: 'otr',
        createdAt: msg.createdAt,
        attachment: null,
      });
      return;
    }

    if (msg.t === 'reminder') {
      toast('Reminder: ' + msg.body);
      state.remindersDue = (state.remindersDue || 0) + 1;
      updateReminderDot();
      if ($('reminderModal').classList.contains('open')) loadReminders();
      return;
    }

    if (msg.t === 'presence' && msg.clientId) {
      const contact = state.contacts.find((c) => c.clientId === msg.clientId);
      if (contact) {
        contact.status = msg.online ? 'Online' : (contact.status === 'Invited' ? 'Invited' : 'Offline');
        if (contact.conversationId === state.activeConvId) {
          $('chatStatus').textContent = contact.status;
          $('chatDot').style.background = msg.online ? 'var(--green)' : '#b9c4d0';
        }
        renderContacts();
      }
      return;
    }

    if (msg.t === 'presence' && msg.userId) {
      const person = state.people.find((p) => p.userId === msg.userId);
      if (person) {
        person.status = msg.online ? (msg.status === 'Offline' ? 'Online' : msg.status || 'Online') : 'Offline';
        if (msg.statusText !== undefined) person.statusText = msg.statusText;
        if (state.activeKind === 'dm' && state.activeUserId === msg.userId) {
          $('chatStatus').textContent = person.status + (person.statusText ? ' · ' + person.statusText : '');
          $('chatDot').style.background = msg.online ? 'var(--green)' : '#b9c4d0';
        }
        renderContacts();
      }
      return;
    }

    if (msg.t === 'operator_status') {
      // another device changed our status; keep the select in sync
      if (msg.status) $('meStatus').value = msg.status;
      return;
    }
  };
}

function showTyping(name) {
  $('typingWho').textContent = name + ' is typing…';
  $('typing').classList.add('on');
  clearTimeout(showTyping._t);
  showTyping._t = setTimeout(() => $('typing').classList.remove('on'), 3000);
}

/* ---------------- notes ---------------- */

let notesTimer = null;
async function loadNotes(clientId) {
  const data = await api(`/api/operator/clients/${clientId}/note`);
  $('notesInput').value = data.body || '';
  $('notesSaved').textContent = data.updatedAt ? 'Saved ' + new Date(data.updatedAt).toLocaleString() : '';
}

function scheduleNoteSave() {
  clearTimeout(notesTimer);
  $('notesSaved').textContent = 'Saving…';
  notesTimer = setTimeout(async () => {
    if (!state.activeClientId) return;
    await api(`/api/operator/clients/${state.activeClientId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ body: $('notesInput').value }),
    });
    $('notesSaved').textContent = 'Saved';
  }, 600);
}

/* ---------------- gallery ---------------- */

async function loadGallery() {
  const host = $('gallery');
  host.innerHTML = '';
  const items = await api(`/api/conversations/${state.activeConvId}/attachments`);
  if (!items.length) {
    host.appendChild(el('div', 'gallery-empty', 'No files shared in this conversation yet.'));
    return;
  }
  for (const it of items) {
    const a = el('a', 'gitem');
    a.href = it.url; a.target = '_blank'; a.rel = 'noopener';
    const thumb = el('div', 'gthumb');
    if ((it.mime || '').startsWith('image/')) {
      const img = el('img'); img.src = it.url; img.alt = it.filename; img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      thumb.textContent = (it.filename.split('.').pop() || 'file').toUpperCase();
    }
    a.append(thumb, el('div', 'gname', esc(it.filename)));
    host.appendChild(a);
  }
}

/* ---------------- slash palette ---------------- */

function openSlash(query) {
  const p = $('slashPalette');
  const q = query.toLowerCase();
  // Match the shortcut itself only. Matching reply text made a command such as
  // "/help" collide with a canned "/hi" whose text happens to say "help".
  state.slashItems = state.canned.filter((c) => c.shortcut.toLowerCase().slice(1).startsWith(q));
  state.slashIndex = state.slashItems.length ? 0 : -1;

  if (!state.slashItems.length) { closeSlash(); return; }
  p.innerHTML = '';
  state.slashItems.forEach((c, i) => {
    const item = el('div', 'slash-item' + (i === state.slashIndex ? ' sel' : ''));
    item.innerHTML = `<span class="k">${esc(c.shortcut)}</span><span class="v">${esc(c.body)}</span>`;
    item.addEventListener('mousedown', (e) => { e.preventDefault(); applySlash(i); });
    p.appendChild(item);
  });
  p.classList.add('open');
}

function closeSlash() {
  $('slashPalette').classList.remove('open');
  state.slashIndex = -1;
}

function applySlash(i) {
  const item = state.slashItems[i];
  if (!item) return;
  const input = $('composerInput');
  input.value = item.body;
  closeSlash();
  input.focus();
  autosize(input);
}

function autosize(t) {
  t.style.height = 'auto';
  t.style.height = Math.min(132, t.scrollHeight) + 'px';
}

/* ---------------- modals ---------------- */

/* In-app confirmation. window.prompt/confirm can be blocked or invisible in
   embedded browsers, which made destructive actions look like they did nothing. */
/* ---------------- rooms: the searchable list behind /list ---------------- */

function openRoomList(rooms) {
  const back = el('div', 'modal-back open');
  const box = el('div', 'modal');
  box.style.maxWidth = '440px';

  const head = el('div', 'mhead', 'Rooms');
  const body = el('div', 'mbody');

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search rooms…';
  search.style.cssText = 'width:100%;border:1px solid var(--border);border-radius:8px;padding:9px 11px;font-size:13px;outline:none';

  const list = el('div');
  list.style.cssText = 'margin-top:10px;max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:2px';

  const join = async (name) => {
    back.remove();
    const res = await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({ text: '/join ' + name, conversationId: state.activeConvId }),
    }).catch(() => null);
    if (!res || !res.ok) { toast((res && res.error) || 'Could not open that room'); return; }
    if (res.refresh) await refresh();
    if (res.openConversationId) openByConversationId(res.openConversationId);
    if (res.message) toast(res.message);
  };

  const rowFor = (label, note, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;border-radius:8px;padding:8px 10px;cursor:pointer;font:inherit;color:inherit';
    b.onmouseenter = () => { b.style.background = 'rgba(28,45,66,.06)'; };
    b.onmouseleave = () => { b.style.background = 'none'; };
    const av = el('span', '', '#');
    av.style.cssText = 'width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:var(--accent);color:#fff;font-weight:700;font-size:13px;flex:none';
    const t = document.createElement('span');
    t.innerHTML = `<div style="font-size:13px;font-weight:600">${esc(label)}</div>` +
      (note ? `<div style="font-size:11.5px;opacity:.65">${esc(note)}</div>` : '');
    b.append(av, t);
    b.addEventListener('click', onClick);
    return b;
  };

  let shown = rooms;
  const render = () => {
    const f = search.value.trim().toLowerCase();
    shown = rooms.filter((r) => !f || r.name.toLowerCase().includes(f));
    list.innerHTML = '';
    if (!shown.length) {
      const none = el('div', 'note', rooms.length ? 'No room matches that.' : 'No rooms yet.');
      none.style.cssText = 'padding:8px 10px;opacity:.7';
      list.appendChild(none);
    }
    for (const r of shown) {
      list.appendChild(rowFor(r.name,
        r.members ? r.members + (r.members === 1 ? ' person' : ' people') + ' inside' : 'open room',
        () => join(r.name)));
    }
    if (!f) {
      list.appendChild(rowFor('Start a new room…', 'Name it and it opens straight away', () => {
        back.remove();
        newRoom();
      }));
    }
  };

  const foot = el('div', 'mfoot');
  const btnClose = el('button', 'btn ghost', 'Close');
  btnClose.addEventListener('click', () => back.remove());
  foot.appendChild(btnClose);

  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && shown.length) join(shown[0].name);
    if (e.key === 'Escape') back.remove();
  });

  body.append(search, list);
  box.append(head, body, foot);
  back.appendChild(box);
  document.body.appendChild(back);
  render();
  search.focus();
}

// A yes/no dialog. No typing: the button says what it does, and Escape or a
// click outside cancels. The old "type CLEAR to confirm" box is gone.
function askConfirm(title, message, word, label) {
  return new Promise((resolve) => {
    const back = el('div', 'modal-back open');
    const box = el('div', 'modal');
    box.style.maxWidth = '420px';

    const head = el('div', 'mhead', esc(title));
    const body = el('div', 'mbody');
    const p = el('div', 'note');
    p.textContent = message;
    body.append(p);

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

/* Single-line text prompt, same reason as above: no native dialogs. */
function askText(title, label, placeholder, value) {
  return new Promise((resolve) => {
    const back = el('div', 'modal-back open');
    const box = el('div', 'modal');
    box.style.maxWidth = '400px';
    const head = el('div', 'mhead', esc(title));
    const body = el('div', 'mbody');
    const field = el('div', 'field');
    const lab = el('label', '', esc(label));
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder || '';
    if (value) input.value = value;
    field.append(lab, input);
    body.appendChild(field);

    const foot = el('div', 'mfoot');
    const cancel = el('button', 'btn ghost', 'Cancel');
    const ok = el('button', 'btn primary', 'Create');
    foot.append(cancel, ok);
    box.append(head, body, foot);
    back.appendChild(box);
    document.body.appendChild(back);
    input.focus();

    const done = (v) => { back.remove(); resolve(v); };
    ok.addEventListener('click', () => done(input.value.trim() || null));
    cancel.addEventListener('click', () => done(null));
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
  });
}

async function newRoom() {
  const title = await askText('New room', 'Room name', 'Lobby');
  if (!title) return;
  try {
    const res = await api('/api/operator/rooms', {
      method: 'POST', body: JSON.stringify({ title }),
    });
    await refresh();
    const room = state.rooms.find((r) => r.conversationId === res.id);
    if (room) openConversation({ ...room, kind: 'room', status: 'Room' });
    showLink(res.link, 'Share this link. Anyone who opens it can join by typing a name.');
  } catch {
    toast('Could not create the room');
  }
}

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

function showLink(link, note) {
  $('linkValue').value = link;
  $('linkNote').textContent = note || '';
  openModal('linkModal');
}

/* ---------------- search ---------------- */

/** Open whatever conversation a search hit belongs to. */
function openByConversationId(convId) {
  const c = state.contacts.find((x) => x.conversationId === convId);
  if (c) { openConversation(c); return true; }
  const g = state.groups.find((x) => x.conversationId === convId);
  if (g) { openConversation({ ...g, kind: 'group' }); return true; }
  const r = state.rooms.find((x) => x.conversationId === convId);
  if (r) { openConversation({ ...r, kind: 'room', status: 'Room' }); return true; }
  const p = state.people.find((x) => x.dmId === convId);
  if (p) {
    openConversation({
      conversationId: p.dmId, name: p.name, kind: 'dm', userId: p.userId,
      status: p.status, statusText: p.statusText,
    });
    return true;
  }
  return false;
}

async function runSearch() {
  const q = $('srchQ').value.trim();
  const from = $('srchFrom').value ? new Date($('srchFrom').value + 'T00:00:00').getTime() : 0;
  const to = $('srchTo').value ? new Date($('srchTo').value + 'T23:59:59').getTime() : 0;
  const clientId = $('srchClient').value;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (from) params.set('from', String(from));
  if (to) params.set('to', String(to));
  if (clientId) params.set('clientId', clientId);

  const data = await api('/api/search?' + params.toString());
  const host = $('searchResults');
  host.innerHTML = '';

  if (!data.messages.length && !data.notes.length) {
    host.appendChild(el('div', 'empty-list', 'No matches.'));
    return;
  }

  for (const n of data.notes) {
    const item = el('div', 'res-item');
    item.innerHTML = `<div class="rhead"><span>Private note · ${esc(n.clientName || 'Client')}</span></div>
      <div class="rbody">${esc(n.body.slice(0, 240))}</div>`;
    item.addEventListener('click', () => {
      const c = state.contacts.find((x) => x.clientId === n.clientId);
      if (c) { closeModal('searchModal'); openConversation(c); }
    });
    host.appendChild(item);
  }

  for (const m of data.messages) {
    const item = el('div', 'res-item');
    item.innerHTML = `<div class="rhead"><span>${esc(m.where || m.clientName || 'Conversation')} · ${esc(m.senderName)}</span>
        <span>${esc(new Date(m.createdAt).toLocaleString())}</span></div>
      <div class="rbody">${esc(m.body.slice(0, 240))}</div>`;
    item.addEventListener('click', () => {
      closeModal('searchModal');
      openByConversationId(m.conversationId);
    });
    host.appendChild(item);
  }
}

/* ---------------- wiring ---------------- */

function wire() {
  $('meStatus').addEventListener('change', async (e) => {
    const status = e.target.value;
    await saveStatus(status, (state.me && state.me.statusMessage) || '');
    toast('Status: ' + status);
  });

  $('btnStatusMsg').addEventListener('click', () => {
    $('statusMsgInput').value = (state.me && state.me.statusMessage) || '';
    $('autoReplyInput').value = (state.me && state.me.autoReply) || '';
    openModal('statusModal');
    $('statusMsgInput').focus();
  });
  $('statusMsgCancel').addEventListener('click', () => closeModal('statusModal'));
  $('statusMsgSave').addEventListener('click', async () => {
    const message = $('statusMsgInput').value.trim().slice(0, 120);
    const autoReply = $('autoReplyInput').value.trim().slice(0, 300);
    await saveStatus($('meStatus').value || 'Online', message, autoReply);
    closeModal('statusModal');
    toast(message ? 'Status message saved' : 'Status message cleared');
  });

  $('btnNewGroup').addEventListener('click', newGroup);
  $('groupCancel').addEventListener('click', () => closeModal('groupModal'));
  $('groupCreate').addEventListener('click', createGroup);
  $('groupName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createGroup(); });

  $('btnMembers').addEventListener('click', openMembers);
  $('membersClose').addEventListener('click', () => closeModal('membersModal'));
  $('memberAddBtn').addEventListener('click', async () => {
    const uid = $('memberAdd').value;
    if (!uid) return;
    await api(`/api/groups/${state.activeConvId}/members`, {
      method: 'POST', body: JSON.stringify({ add: [uid] }),
    });
    await refresh();
    openMembers();
  });

  $('btnAdmin').addEventListener('click', () => { location.href = '/admin'; });
  $('btnManualRail').addEventListener('click', () => { window.open('/help', '_blank', 'noopener'); });

  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.tab = b.dataset.tab;
      renderContacts();
    });
  });

  // Typing never touches the sidebar: it floats comic bubbles over the list.
  // Only text the user actually typed counts — browsers autofill stray inputs
  // with the saved username, and that used to hide every room silently.
  $('filterInput').addEventListener('input', (e) => {
    if (document.activeElement !== e.target) return;
    state.filter = e.target.value;
    renderSearchBubble();
  });
  // The little x inside a type=search field fires "search", not always "input".
  $('filterInput').addEventListener('search', () => {
    state.filter = $('filterInput').value;
    renderSearchBubble();
  });
  $('filterInput').addEventListener('focus', () => {
    if (state.filter.trim()) renderSearchBubble();
  });

  // Escape is the reflex for "get me out of this search"; it used to do nothing.
  $('filterInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    clearFilter();
  });

  // Scrolling the list or tapping elsewhere puts the hover bubble away.
  const scroller = $('contacts');
  if (scroller) scroller.addEventListener('scroll', hideRowBubble, { passive: true });
  document.addEventListener('click', (e) => {
    hideRowBubble();
    if (!state.filter.trim()) return;
    if (e.target.closest && e.target.closest('.searchbar')) return;
    closeSearchBubble();
  });

  $('btnNewClient').addEventListener('click', () => {
    const lan = (state.accessUrls || []).filter((u) => !u.includes('localhost'));
    $('invAccess').textContent = lan.length
      ? 'A phone on the same network can open links at ' + lan.join(' or ') + '. Links use the address you are signed in on.'
      : 'Open this app on the address you want clients to use, so links carry a reachable host.';
    $('inviteResult').style.display = 'none';
    $('invName').value = '';
    $('invEmail').value = '';
    $('inviteCreate').disabled = false;
    $('inviteCreate').textContent = 'Create link';
    openModal('inviteModal');
    $('invName').focus();
  });
  $('inviteCancel').addEventListener('click', () => closeModal('inviteModal'));

  $('inviteCreate').addEventListener('click', async () => {
    const name = $('invName').value.trim();
    if (!name) { toast('Name is required'); return; }
    $('inviteCreate').disabled = true;
    try {
      const res = await api('/api/operator/clients', {
        method: 'POST',
        body: JSON.stringify({ display_name: name, email: $('invEmail').value.trim() }),
      });
      $('invLink').value = res.link;
      $('inviteResult').style.display = 'block';
      $('inviteCreate').textContent = 'Done';
      await refresh();
      toast('Invite created');
    } catch {
      toast('Could not create the invite');
      $('inviteCreate').disabled = false;
    }
  });

  $('btnCopyInvite').addEventListener('click', () => {
    navigator.clipboard?.writeText($('invLink').value);
    toast('Link copied');
  });
  $('btnCopyLink').addEventListener('click', () => {
    navigator.clipboard?.writeText($('linkValue').value);
    toast('Link copied');
  });
  $('linkClose').addEventListener('click', () => closeModal('linkModal'));

  /* ---- tools: polls, presets, acknowledgements, OTR, notes, reminders ---- */

  $('btnTools').addEventListener('click', (e) => {
    e.stopPropagation();
    $('ackToolLabel').textContent = state.pendingAck ? 'Cancel acknowledgement' : 'Require acknowledgement';
    $('otrToolLabel').textContent = state.otrOn ? 'Stop off-the-record' : 'Off the record';
    $('announceToolLabel').textContent = state.pendingAnnounce ? 'Cancel announcement' : 'Send as announcement';
    $('announceTool').hidden = !(state.me && state.me.admin) || state.activeKind === 'client' || state.activeAnnounce;
    $('toolsMenu').classList.toggle('open');
  });
  $('toolsMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tool]');
    if (!b) return;
    $('toolsMenu').classList.remove('open');
    handleTool(b.dataset.tool);
  });
  document.addEventListener('click', () => $('toolsMenu').classList.remove('open'));

  $('ackChipClear').addEventListener('click', () => {
    state.pendingAck = false;
    state.pendingAnnounce = false;
    updateComposerChips();
  });
  $('btnOtrOff').addEventListener('click', () => {
    state.otrOn = false;
    updateComposerChips();
    toast('Off the record turned off');
  });

  $('pollCancel').addEventListener('click', () => closeModal('pollModal'));
  $('pollSend').addEventListener('click', sendPoll);
  $('pollAddOption').addEventListener('click', () => {
    const host = $('pollOptions');
    if (host.children.length >= 8) { toast('Eight options is the maximum'); return; }
    const inp = document.createElement('input');
    inp.className = 'poll-opt';
    inp.placeholder = 'Option ' + (host.children.length + 1);
    host.appendChild(inp);
    inp.focus();
  });

  $('presetClose').addEventListener('click', () => closeModal('presetModal'));
  $('stickyClose').addEventListener('click', () => closeModal('stickyModal'));
  $('stickyAdd').addEventListener('click', addSticky);
  $('reminderClose').addEventListener('click', () => closeModal('reminderModal'));
  $('reminderAdd').addEventListener('click', addReminder);
  $('btnStickyRail').addEventListener('click', openStickies);
  $('btnRemindersRail').addEventListener('click', openReminders);

  $('announceRow').addEventListener('click', () => {
    if (!state.announcements) return;
    openConversation({
      conversationId: state.announcements.conversationId,
      name: 'Announcements', kind: 'announce', status: '',
    });
  });

  $('btnSend').addEventListener('click', sendMessage);

  const input = $('composerInput');
  input.addEventListener('keydown', (e) => {
    const paletteOpen = $('slashPalette').classList.contains('open');
    if (paletteOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.slashIndex = (state.slashIndex + 1) % state.slashItems.length;
        openSlash(input.value.slice(1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.slashIndex = (state.slashIndex - 1 + state.slashItems.length) % state.slashItems.length;
        openSlash(input.value.slice(1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySlash(state.slashIndex);
        return;
      }
      if (e.key === 'Escape') { closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener('input', () => {
    autosize(input);
    const v = input.value;
    if (v.startsWith('/') && v.length <= 24) openSlash(v.slice(1));
    else closeSlash();

    if (state.activeConvId) {
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => {
        api(`/api/conversations/${state.activeConvId}/typing`, { method: 'POST' }).catch(() => {});
      }, 350);
    }
  });

  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); uploadFile(f); return; }
      }
    }
  });

  $('btnAttach').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) uploadFile(f);
    e.target.value = '';
  });

  const messages = $('messages');
  messages.addEventListener('dragover', (e) => e.preventDefault());
  messages.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) uploadFile(f);
  });

  document.querySelectorAll('.head-tab').forEach((b) => {
    b.addEventListener('click', () => switchHeadTab(b.dataset.htab));
  });

  $('btnMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    // Only offer the actions that make sense for what is open.
    const show = {
      link: state.activeKind === 'client' || state.activeKind === 'room',
      regenerate: state.activeKind === 'client',
      revoke: state.activeKind === 'client',
      transcript: state.activeKind === 'client',
      archive: state.activeKind === 'client',
              delete: !!state.activeConvId,
        clear: !!state.activeConvId,
      members: state.activeGroup,
      leave: state.activeGroup,
    };
    $('chatMenu').querySelectorAll('button[data-act]').forEach((b) => {
      const act = b.dataset.act;
      if (act in show) b.hidden = !show[act];
    });
    $('chatMenu').classList.toggle('open');
  });
  document.addEventListener('click', () => $('chatMenu').classList.remove('open'));

  $('chatMenu').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const contact = state.contacts.find((c) => c.conversationId === state.activeConvId) ||
      state.rooms.find((c) => c.conversationId === state.activeConvId) ||
      state.groups.find((g) => g.conversationId === state.activeConvId) ||
      state.people.find((p) => p.dmId === state.activeConvId);
    $('chatMenu').classList.remove('open');
    if (!contact) return;

          if (act === 'members') { openMembers(); return; }
      if (act === 'leave') { leaveGroup(); return; }
      // Clear and delete work from the menu in every kind of chat, no typing needed.
      if (act === 'clear') { await clearThread(); return; }
      if (act === 'delete' && (state.activeKind === 'dm' || state.activeKind === 'group')) {
        const sure = await askConfirm('Delete this conversation?',
          'Every message and attached file in it is erased for everyone. There is no undo.',
          'DELETE', 'Delete');
        if (!sure) return;
        await api(`/api/operator/conversations/${state.activeConvId}`, {
          method: 'DELETE', body: JSON.stringify({ confirm: true }),
        }).catch(() => null);
        state.activeConvId = null;
        state.messages = [];
        $('chatMain').style.display = 'none';
        $('chatEmpty').style.display = 'grid';
        await refresh();
        toast('Conversation deleted');
        return;
      }

    if (contact.kind === 'room') {
      if (act === 'link') {
        showLink(`${location.origin}/r/${contact.conversationId}`,
          'Anyone who opens this link can join the room by typing a name.');
        return;
      }
      if (act === 'clear') { await clearThread(); return; }
      if (act === 'delete') {
        const sure = await askConfirm('Delete this room?',
          'Every message in the room is erased and the link stops working. There is no undo.',
          'DELETE', 'Delete room');
        if (!sure) return;
        await api(`/api/operator/rooms/${contact.conversationId}`, { method: 'DELETE' });
        state.activeConvId = null;
        state.messages = [];
        $('chatMain').style.display = 'none';
        $('chatEmpty').style.display = 'grid';
        await refresh();
        toast('Room deleted');
        return;
      }
      return;
    }

    if (act === 'link' || act === 'regenerate') {
      const res = await api(`/api/operator/clients/${contact.clientId}/link`, { method: 'POST' });
      showLink(res.link, act === 'regenerate'
        ? 'The previous link stopped working immediately.'
        : 'Regenerating replaces this link. Shown once.');
      return;
    }
    if (act === 'revoke') {
      const sure = await askConfirm(
        'Revoke this client link?',
        'The current invite URL stops working immediately. You can generate a new one afterwards.',
        'REVOKE',
        'Revoke link'
      );
      if (!sure) return;
      await api(`/api/operator/clients/${contact.clientId}/revoke`, { method: 'POST' });
      toast('Link revoked');
      return;
    }
    if (act === 'archive') {
      const archived = !contact.archived;
      await api(`/api/operator/conversations/${state.activeConvId}/archive`, {
        method: 'POST', body: JSON.stringify({ archived }),
      });
      contact.archived = archived;
      toast(archived ? 'Conversation archived' : 'Conversation reopened');
      renderContacts();
      return;
    }
    if (act === 'clear') {
      await clearThread();
      return;
    }
    if (act === 'delete') {
      const sure = await askConfirm(
        'Delete this conversation?',
        'All messages, files, notes and the client link are erased. There is no undo.',
        'DELETE',
        'Delete'
      );
      if (!sure) return;
      await api(`/api/operator/conversations/${state.activeConvId}`, {
        method: 'DELETE', body: JSON.stringify({ confirm: true }),
      });
      state.contacts = state.contacts.filter((x) => x.clientId !== contact.clientId);
      state.activeConvId = null;
      state.activeClientId = null;
      state.messages = [];
      $('chatMain').style.display = 'none';
      $('chatEmpty').style.display = 'grid';
      renderContacts();
      toast('Conversation deleted');
      return;
    }

    if (act === 'transcript') {
      const res = await api(`/api/conversations/${state.activeConvId}/transcript`, { method: 'POST' });
      if (res.emailed) toast('Transcript emailed to the client');
      else {
        showLink('', 'No email on file — the transcript was written below.');
        $('linkModalTitle').textContent = 'Transcript';
        const ta = document.createElement('textarea');
        ta.value = res.transcript || '';
        ta.style.cssText = 'width:100%;height:220px;border:1px solid var(--border);border-radius:8px;padding:8px;font-family:ui-monospace,monospace;font-size:11.5px';
        $('linkModal').querySelector('.mbody').appendChild(ta);
        openModal('linkModal');
      }
      return;
    }
  });

  $('btnNotes').addEventListener('click', () => $('notesDrawer').classList.toggle('open'));
  $('btnNotesClose').addEventListener('click', () => $('notesDrawer').classList.remove('open'));
  $('notesInput').addEventListener('input', scheduleNoteSave);

  $('btnSearchRail').addEventListener('click', () => {
    const sel = $('srchClient');
    sel.innerHTML = '<option value="">All clients</option>';
    for (const c of state.contacts) {
      const o = document.createElement('option');
      o.value = c.clientId; o.textContent = c.name;
      sel.appendChild(o);
    }
    $('searchResults').innerHTML = '';
    openModal('searchModal');
    $('srchQ').focus();
  });
  $('searchClose').addEventListener('click', () => closeModal('searchModal'));
  $('searchRun').addEventListener('click', runSearch);
  $('srchQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  $('btnArchiveRail').addEventListener('click', () => {
    state.tab = state.tab === 'archived' ? 'all' : 'archived';
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === state.tab));
    renderContacts();
  });

  $('btnBack').addEventListener('click', () => $('shell').classList.remove('show-chat'));

  $('btnLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/login';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSlash();
      ['inviteModal', 'searchModal', 'linkModal'].forEach(closeModal);
      $('chatMenu').classList.remove('open');
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('btnSearchRail').click();
    }
  });
}

/* Features the administrator can load and unload from the panel. */
const MODULE_BUTTONS = {
  search: 'btnSearchRail', archive: 'btnArchiveRail', notes: 'btnStickyRail',
  reminders: 'btnRemindersRail', tasks: 'btnTasksRail', calendar: 'btnCalendarRail',
  leave: 'btnLeaveRail', drive: 'btnDriveRail', mail: 'btnMailRail', helpdesk: 'btnHelpRail',
  wall: 'btnWallRail',
};
const MODULE_MODALS = {
  search: 'searchModal', notes: 'stickyModal', reminders: 'reminderModal',
  tasks: 'tasksModal', calendar: 'calModal', leave: 'leaveModal', drive: 'driveModal',
  mail: 'mailModal', helpdesk: 'helpModal', wall: 'wallModal',
};

function moduleOn(mid) {
  return !state.modules || state.modules[mid] !== false;
}

/** Rail icons follow the loaded modules; unloading one hides it everywhere. */
function applyModules() {
  const flags = (state.me && state.me.flags) || { drive: true };
  for (const mid of Object.keys(MODULE_BUTTONS)) {
    const btn = $(MODULE_BUTTONS[mid]);
    if (!btn) continue;
    let show = moduleOn(mid);
    if (mid === 'helpdesk') show = show && !!(state.me && state.me.admin);
    if (mid === 'drive') show = show && !!flags.drive;
    btn.hidden = !show;
    if (show) continue;
    const badge = btn.querySelector('.dot');
    if (badge) badge.hidden = true;
    const modalId = MODULE_MODALS[mid];
    const modal = modalId && $(modalId);
    if (modal && modal.classList.contains('open')) closeModal(modalId);
  }
  const leaveLink = $('calLeave');
  if (leaveLink) leaveLink.hidden = !moduleOn('leave');
}

async function refresh() {
  const data = await api('/api/bootstrap');
  // The account's saved colour, so a new public port does not lose it.
  if (data && data.theme && window.syncThemeFromServer) window.syncThemeFromServer(data.theme);
  state.me = data.me;
  state.modules = data.modules || null;
  state.people = data.people || [];
  state.groups = data.groups || [];
  state.contacts = data.contacts || [];
  state.rooms = data.rooms || [];
  state.departments = data.departments || [];
  state.canned = data.canned || [];
  state.accessUrls = data.accessUrls || [];
  state.announcements = data.announcements || null;
  state.otrAllowed = !(data.settings && data.settings.otrAllowed === false);
  state.remindersDue = Number(data.remindersDue || 0);

  $('meName').textContent = data.me.name;
  const av = $('meAvatar');
  av.textContent = initials(data.me.name);
  av.style.background = colorFor(data.me.name);
  if (data.me.status) $('meStatus').value = data.me.status === 'Offline' ? 'Offline' : data.me.status;

  // Admin-only controls: the panel, and inviting clients.
  $('btnAdmin').hidden = !data.me.admin;
  $('btnNewClient').hidden = !data.me.admin;
  $('railMail').hidden = !Number(data.mailUnread || 0);
  $('railHelp').hidden = !Number(data.ticketsOpen || 0);

  // Per-person switches the administrator controls.
  const flags = data.me.flags || { files: true, calls: true, otr: true, drive: true };
  $('btnAttach').hidden = !flags.files;
  const otrTool = document.querySelector('[data-tool="otr"]');
  if (otrTool) otrTool.hidden = !flags.otr;
  applyModules();

  const line = $('myStatusLine');
  const dept = data.me.department ? data.me.department + ' · ' : '';
  line.textContent = data.me.statusMessage
    ? dept + data.me.statusMessage
    : dept + (data.me.role === 'admin' ? 'Administrator' : data.me.role === 'manager' ? 'Manager' : 'Member');
  line.hidden = false;

  // Team announcements are always one click away in the sidebar.
  const ann = state.announcements;
  const annRow = $('announceRow');
  annRow.hidden = !ann;
  if (ann) {
    $('announcePreview').textContent = ann.lastMessage || 'Team-wide notices';
    const badge = $('announceUnread');
    badge.hidden = !ann.unread;
    badge.textContent = String(ann.unread || '');
    annRow.classList.toggle('active', ann.conversationId === state.activeConvId);
  }
  updateReminderDot();

  renderContacts();
  updateRailBadge();
}

/* ---------------- groups, members, status ---------------- */

function newGroup() {
  const host = $('groupPeople');
  host.innerHTML = '';
  const others = state.people.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!others.length) {
    host.appendChild(el('div', 'empty-list', 'No colleagues yet. Add people in the admin panel first.'));
  }
  for (const p of others) {
    const row = el('label', 'pick-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.userId;
    row.append(cb, el('span', 'pick-name', esc(p.name)));
    if (p.department) row.appendChild(el('span', 'pick-dept', esc(p.department)));
    host.appendChild(row);
  }
  $('groupName').value = '';
  openModal('groupModal');
  $('groupName').focus();
}

async function createGroup() {
  const title = $('groupName').value.trim();
  if (!title) { toast('Give the group a name'); return; }
  const memberIds = [...$('groupPeople').querySelectorAll('input:checked')].map((c) => c.value);
  try {
    const res = await api('/api/groups', { method: 'POST', body: JSON.stringify({ title, memberIds }) });
    closeModal('groupModal');
    await refresh();
    const group = state.groups.find((g) => g.conversationId === res.id) || {
      conversationId: res.id, name: title, members: memberIds.length + 1,
    };
    openConversation({ ...group, kind: 'group', status: '', members: group.members });
    toast('Group created');
  } catch {
    toast('Could not create the group');
  }
}

async function openMembers() {
  if (!state.activeGroup || !state.activeConvId) return;
  const list = await api(`/api/groups/${state.activeConvId}/members`);
  const host = $('memberList');
  host.innerHTML = '';
  for (const m of list) {
    const row = el('div', 'member-row');
    const av = avatarNode(m.name, 'sm');
    const status = m.status === 'Online' ? 'var(--green)' : m.status === 'Busy' ? 'var(--red)' : '#b9c4d0';
    row.append(av, el('div', 'member-name', esc(m.name) + (m.statusText ? `<div class="member-sub">${esc(m.statusText)}</div>` : '')));
    row.appendChild(el('span', 'presence-dot', ''));
    row.lastChild.style.background = status;
    if (m.userId !== (state.me && state.me.id)) {
      const rm = el('button', 'link-danger', 'Remove');
      rm.addEventListener('click', async () => {
        await api(`/api/groups/${state.activeConvId}/members`, {
          method: 'POST', body: JSON.stringify({ remove: [m.userId] }),
        });
        openMembers();
      });
      row.appendChild(rm);
    } else {
      row.appendChild(el('span', 'pill', 'You'));
    }
    host.appendChild(row);
  }

  const sel = $('memberAdd');
  sel.innerHTML = '';
  const memberIds = new Set(list.map((m) => m.userId));
  for (const p of state.people) {
    if (memberIds.has(p.userId)) continue;
    const o = document.createElement('option');
    o.value = p.userId;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  openModal('membersModal');
}

async function leaveGroup() {
  if (!state.activeGroup || !state.activeConvId) return;
  const ok = await askConfirm('Leave this group?',
    'You stop receiving its messages. The group and its history stay for the other members.',
    'LEAVE', 'Leave group');
  if (!ok) return;
  await api(`/api/groups/${state.activeConvId}/leave`, { method: 'POST' });
  state.activeConvId = null;
  state.messages = [];
  $('chatMain').style.display = 'none';
  $('chatEmpty').style.display = 'grid';
  await refresh();
  toast('You left the group');
}

async function saveStatus(status, message, autoReply) {
  const payload = { status, message };
  if (autoReply !== undefined) payload.autoReply = autoReply;
  await api('/api/status', { method: 'POST', body: JSON.stringify(payload) });
  if (state.me) {
    state.me.status = status;
    state.me.statusMessage = message;
    if (autoReply !== undefined) state.me.autoReply = autoReply;
  }
  $('myStatusLine').textContent = message || (state.me?.department ? state.me.department + ' · ' : '') +
    (state.me?.role === 'admin' ? 'Administrator' : state.me?.role === 'manager' ? 'Manager' : 'Member');
  $('meDot').style.background =
    status === 'Online' ? 'var(--green)' : status === 'Busy' ? 'var(--red)' : status === 'Offline' ? '#b9c4d0' : 'var(--amber)';
}

/* ---------------- tools: polls, presets, notes, reminders ---------------- */

function updateComposerChips() {
  const chip = $('ackChip');
  let text = '';
  if (state.pendingAnnounce) text = 'Next message goes out as an announcement';
  else if (state.pendingAck) text = 'Next message asks for an acknowledgement';
  chip.hidden = !text;
  if (text) chip.querySelector('span').textContent = text;
  $('otrBanner').hidden = !state.otrOn;
  const input = $('composerInput');
  if (input) input.placeholder = state.otrOn ? 'Off the record — nothing is saved' : 'Type a message';
}

function updateReminderDot() {
  $('railReminders').hidden = !(state.remindersDue > 0);
}

function handleTool(tool) {
  if (tool === 'poll') { openPoll(); return; }
  if (tool === 'preset') { openPresets(); return; }
  if (tool === 'ack') {
    state.pendingAck = !state.pendingAck;
    if (state.pendingAck) state.pendingAnnounce = false;
    updateComposerChips();
    return;
  }
  if (tool === 'announce') {
    state.pendingAnnounce = !state.pendingAnnounce;
    if (state.pendingAnnounce) state.pendingAck = false;
    updateComposerChips();
    return;
  }
  if (tool === 'otr') {
    if (state.activeKind === 'client') { toast('Client threads are always saved'); return; }
    if (!state.otrAllowed) { toast('Off-the-record messages are switched off'); return; }
    state.otrOn = !state.otrOn;
    updateComposerChips();
    if (state.otrOn) toast('Off the record — nothing is saved');
    return;
  }
  if (tool === 'stickies') { openStickies(); return; }
  if (tool === 'reminders') { openReminders(); return; }
  if (tool === 'clip') { openClip(); return; }
}

function openPoll() {
  $('pollQuestion').value = '';
  const host = $('pollOptions');
  host.innerHTML = '';
  for (let i = 1; i <= 3; i += 1) {
    const inp = document.createElement('input');
    inp.className = 'poll-opt';
    inp.placeholder = 'Option ' + i;
    host.appendChild(inp);
  }
  $('pollMulti').checked = false;
  openModal('pollModal');
  $('pollQuestion').focus();
}

async function sendPoll() {
  const question = $('pollQuestion').value.trim();
  const options = [...document.querySelectorAll('#pollOptions .poll-opt')]
    .map((i) => i.value.trim()).filter(Boolean);
  if (!question) { toast('A poll needs a question'); return; }
  if (options.length < 2) { toast('Give it at least two options'); return; }
  const res = await api(`/api/conversations/${state.activeConvId}/polls`, {
    method: 'POST', body: JSON.stringify({ question, options, multi: $('pollMulti').checked }),
  });
  if (res.error) { toast(res.error); return; }
  reconcile(res.message);
  closeModal('pollModal');
}

function openPresets() {
  const host = $('presetList');
  host.innerHTML = '';
  if (!state.canned.length) host.appendChild(el('div', 'empty-list', 'No preset messages saved yet.'));
  for (const c of state.canned) {
    const row = el('button', 'preset-row');
    row.innerHTML = `<span class="k">${esc(c.shortcut)}</span><span class="v">${esc(c.body)}</span>`;
    row.addEventListener('click', () => {
      closeModal('presetModal');
      const input = $('composerInput');
      input.value = c.body;
      autosize(input);
      sendMessage();
    });
    host.appendChild(row);
  }
  openModal('presetModal');
}

async function openStickies() {
  openModal('stickyModal');
  await loadStickies();
}

async function loadStickies() {
  const host = $('stickyList');
  host.innerHTML = '';
  const items = await api('/api/notes');
  if (!items.length) {
    host.appendChild(el('div', 'empty-list', 'No notes yet. Anything you write here is private to you.'));
    return;
  }
  for (const n of items) {
    const card = el('div', 'sticky ' + esc(n.colour));
    card.appendChild(el('div', 'sticky-body', esc(n.body)));
    const del = el('button', 'link-danger', 'Delete');
    del.addEventListener('click', async () => {
      await api('/api/notes/' + n.id, { method: 'DELETE' });
      await loadStickies();
    });
    card.appendChild(del);
    host.appendChild(card);
  }
}

async function addSticky() {
  const text = $('stickyBody').value.trim();
  if (!text) { toast('Write something first'); return; }
  const res = await api('/api/notes', {
    method: 'POST', body: JSON.stringify({ body: text, colour: $('stickyColour').value }),
  });
  if (res.error) { toast(res.error); return; }
  $('stickyBody').value = '';
  await loadStickies();
}

function localDatetimeValue(ts) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

async function openReminders() {
  openModal('reminderModal');
  if (!$('reminderWhen').value) $('reminderWhen').value = localDatetimeValue(Date.now() + 30 * 60000);
  await loadReminders();
}

async function loadReminders() {
  const host = $('reminderList');
  host.innerHTML = '';
  const items = await api('/api/reminders');
  state.remindersDue = items.filter((r) => r.dueAt <= Date.now()).length;
  updateReminderDot();
  if (!items.length) {
    host.appendChild(el('div', 'empty-list', 'No reminders set.'));
    return;
  }
  for (const r of items) {
    const row = el('div', 'reminder-row' + (r.dueAt <= Date.now() ? ' due' : ''));
    row.innerHTML = `<div class="rbody"><div>${esc(r.body)}</div>
      <div class="rtime">${esc(new Date(r.dueAt).toLocaleString())}</div></div>`;
    const done = el('button', 'btn small', 'Done');
    done.addEventListener('click', async () => {
      await api('/api/reminders/' + r.id, { method: 'POST' });
      await loadReminders();
    });
    const del = el('button', 'link-danger', 'Delete');
    del.addEventListener('click', async () => {
      await api('/api/reminders/' + r.id, { method: 'DELETE' });
      await loadReminders();
    });
    row.append(done, del);
    host.appendChild(row);
  }
}

async function addReminder() {
  const body = $('reminderBody').value.trim();
  const when = $('reminderWhen').value;
  if (!body) { toast('What should I remind you about?'); return; }
  const dueAt = when ? new Date(when).getTime() : 0;
  if (!dueAt || dueAt < Date.now()) { toast('Pick a time in the future'); return; }
  const res = await api('/api/reminders', {
    method: 'POST',
    body: JSON.stringify({ body, dueAt, conversationId: state.activeConvId }),
  });
  if (res.error) { toast(res.error); return; }
  $('reminderBody').value = '';
  await loadReminders();
  toast('Reminder set');
}

async function boot() {
  wire();
  resetFilterOnBoot();
  if (window.initThemePicker) window.initThemePicker();
  await refresh();
  connectWS();
  loadWorkOnBoot();
  setInterval(loadHours, 60000);

  // The administrator can require two-factor before the app is usable.
  if (state.me && state.me.needs2fa) {
    openModal('twofaModal');
    $('twofaHint').textContent = 'Your administrator requires two-factor sign-in before you can use the app.';
    loadTwofa().catch(() => {});
  }

  // Reopen the first unread conversation, else the most recent one.
  const people = state.people.filter((p) => p.dmId);
  const all = [...people, ...state.groups, ...state.rooms, ...state.contacts.filter((c) => !c.archived)];
  const first = all.find((c) => c.unread > 0) || all[0];
  if (first) {
    if (first.userId) {
      openConversation({
        conversationId: first.dmId, name: first.name, kind: 'dm', userId: first.userId,
        status: first.status, statusText: first.statusText,
      });
    } else if (first.kind === 'group') {
      openConversation({ ...first, kind: 'group' });
    } else if (first.kind === 'room') {
      openConversation({ ...first, kind: 'room', status: 'Room' });
    } else {
      openConversation(first);
    }
  }

  setInterval(() => { if (state.activeConvId) markRead(); }, 20000);
  // Rooms have no websocket subscription yet; refresh them while open.
  setInterval(() => {
    if (state.activeRoom && state.activeConvId) loadMessages(state.lastSeq).catch(() => {});
  }, 2500);
}

/* ------------------------------------------------------------------ */
/* Screen clipper                                                      */
/* ------------------------------------------------------------------ */

const clip = { base: null, mode: 'crop', colour: '#e5484d', shapes: [], crop: null, drag: null, scale: 1 };

async function openClip() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('This browser cannot capture the screen');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    toast('Screen capture was cancelled');
    return;
  }
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  try { await video.play(); } catch { /* Chromium plays muted streams */ }
  await new Promise((r) => setTimeout(r, 350));
  const w = video.videoWidth;
  const h = video.videoHeight;
  stream.getTracks().forEach((t) => t.stop());
  if (!w || !h) { toast('Could not read the screen'); return; }

  const base = document.createElement('canvas');
  base.width = w;
  base.height = h;
  base.getContext('2d').drawImage(video, 0, 0, w, h);
  clip.base = base;
  clip.shapes = [];
  clip.crop = { x: 0, y: 0, w, h };
  clip.mode = 'crop';
  clip.drag = null;
  syncClipTools();

  const canvas = $('clipCanvas');
  canvas.width = w;
  canvas.height = h;
  openModal('clipModal');
  drawClip();
}

function syncClipTools() {
  $('clipCrop').classList.toggle('on', clip.mode === 'crop');
  $('clipPen').classList.toggle('on', clip.mode === 'pen');
  $('clipArrow').classList.toggle('on', clip.mode === 'arrow');
  for (const sw of document.querySelectorAll('#clipColours .swatch')) {
    sw.classList.toggle('on', sw.dataset.colour === clip.colour);
  }
}

function drawClip() {
  const canvas = $('clipCanvas');
  const ctx = canvas.getContext('2d');
  if (!clip.base) return;
  canvas.width = clip.base.width;
  canvas.height = clip.base.height;
  ctx.drawImage(clip.base, 0, 0);

  if (clip.crop && (clip.crop.w < canvas.width || clip.crop.h < canvas.height)) {
    ctx.save();
    ctx.fillStyle = 'rgba(6, 12, 22, 0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(clip.crop.x, clip.crop.y, clip.crop.w, clip.crop.h);
    ctx.fill('evenodd');
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = Math.max(1.5, canvas.width / 900);
    ctx.strokeRect(clip.crop.x, clip.crop.y, clip.crop.w, clip.crop.h);
    ctx.restore();
  }

  for (const shape of clip.shapes) paintShape(ctx, shape);
  if (clip.drag && clip.drag.shape) paintShape(ctx, clip.drag.shape);
}

function paintShape(ctx, shape) {
  ctx.save();
  ctx.strokeStyle = shape.colour;
  ctx.fillStyle = shape.colour;
  ctx.lineWidth = Math.max(3, (clip.base ? clip.base.width : 1000) / 320);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (shape.type === 'pen') {
    ctx.beginPath();
    shape.points.forEach((pt, i) => { if (i) ctx.lineTo(pt.x, pt.y); else ctx.moveTo(pt.x, pt.y); });
    ctx.stroke();
  } else if (shape.type === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(shape.from.x, shape.from.y);
    ctx.lineTo(shape.to.x, shape.to.y);
    ctx.stroke();
    const angle = Math.atan2(shape.to.y - shape.from.y, shape.to.x - shape.from.x);
    const head = Math.max(14, ctx.lineWidth * 5);
    ctx.beginPath();
    ctx.moveTo(shape.to.x, shape.to.y);
    ctx.lineTo(shape.to.x - head * Math.cos(angle - 0.42), shape.to.y - head * Math.sin(angle - 0.42));
    ctx.lineTo(shape.to.x - head * Math.cos(angle + 0.42), shape.to.y - head * Math.sin(angle + 0.42));
    ctx.closePath();
    ctx.fill();
  } else if (shape.type === 'cropbox') {
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
  }
  ctx.restore();
}

function clipPoint(e) {
  const canvas = $('clipCanvas');
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);
  return {
    x: Math.max(0, Math.min(canvas.width, x)),
    y: Math.max(0, Math.min(canvas.height, y)),
  };
}

function wireClipCanvas() {
  const canvas = $('clipCanvas');

  canvas.addEventListener('pointerdown', (e) => {
    if (!clip.base) return;
    canvas.setPointerCapture(e.pointerId);
    const pt = clipPoint(e);
    if (clip.mode === 'crop') {
      clip.drag = { from: pt, shape: { type: 'cropbox', x: pt.x, y: pt.y, w: 0, h: 0 } };
    } else if (clip.mode === 'pen') {
      clip.drag = { shape: { type: 'pen', colour: clip.colour, points: [pt] } };
    } else {
      clip.drag = { shape: { type: 'arrow', colour: clip.colour, from: pt, to: pt } };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!clip.drag) return;
    const pt = clipPoint(e);
    const shape = clip.drag.shape;
    if (shape.type === 'cropbox') {
      shape.x = Math.min(clip.drag.from.x, pt.x);
      shape.y = Math.min(clip.drag.from.y, pt.y);
      shape.w = Math.abs(pt.x - clip.drag.from.x);
      shape.h = Math.abs(pt.y - clip.drag.from.y);
    } else if (shape.type === 'pen') {
      shape.points.push(pt);
    } else {
      shape.to = pt;
    }
    drawClip();
  });

  const finish = () => {
    if (!clip.drag) return;
    const shape = clip.drag.shape;
    if (shape.type === 'cropbox') {
      if (shape.w > 12 && shape.h > 12) clip.crop = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    } else if (shape.type === 'pen') {
      if (shape.points.length > 1) clip.shapes.push(shape);
    } else if (Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) > 8) {
      clip.shapes.push(shape);
    }
    clip.drag = null;
    drawClip();
  };

  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  $('clipCrop').addEventListener('click', () => { clip.mode = 'crop'; syncClipTools(); });
  $('clipPen').addEventListener('click', () => { clip.mode = 'pen'; syncClipTools(); });
  $('clipArrow').addEventListener('click', () => { clip.mode = 'arrow'; syncClipTools(); });
  $('clipColours').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    clip.colour = sw.dataset.colour;
    syncClipTools();
  });
  $('clipUndo').addEventListener('click', () => { clip.shapes.pop(); drawClip(); });
  $('clipReset').addEventListener('click', () => {
    clip.shapes = [];
    if (clip.base) clip.crop = { x: 0, y: 0, w: clip.base.width, h: clip.base.height };
    drawClip();
  });
  $('clipRetake').addEventListener('click', () => { closeModal('clipModal'); openClip(); });
  $('clipCancel').addEventListener('click', () => closeModal('clipModal'));
  $('clipSend').addEventListener('click', sendClip);
}

async function sendClip() {
  if (!clip.base || !state.activeConvId) { toast('Open a chat first'); return; }
  const crop = clip.crop || { x: 0, y: 0, w: clip.base.width, h: clip.base.height };
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(crop.w));
  out.height = Math.max(1, Math.round(crop.h));
  const ctx = out.getContext('2d');
  ctx.drawImage(clip.base, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
  ctx.translate(-crop.x, -crop.y);
  for (const shape of clip.shapes) paintShape(ctx, shape);

  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  if (!blob) { toast('Could not prepare the clip'); return; }
  const name = 'screen-clip-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.png';
  const file = new File([blob], name, { type: 'image/png' });
  closeModal('clipModal');
  await uploadFile(file, { quiet: true });
}

/* ------------------------------------------------------------------ */
/* Work: tasks, calendar, meetings, time off, the clock                */
/* ------------------------------------------------------------------ */

state.tasks = [];
state.taskFilter = 'open';
state.workPeople = [];
state.events = [];
state.calMode = 'week';
state.calAnchor = 0;
state.leave = { mine: [], team: [], holidays: [] };
state.hours = { todayMinutes: 0, since: null };
state.editEventId = null;
state.openEvent = null;

const pad2 = (n) => String(n).padStart(2, '0');
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function mondayOf(ts) {
  const d = new Date(startOfDay(ts));
  return d.getTime() - ((d.getDay() + 6) % 7) * 86400000;
}
function fmtMinutes(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
}
function fmtDue(ts) {
  if (!ts) return '';
  const sameDay = new Date(ts).toDateString() === new Date().toDateString();
  return (sameDay ? 'Today ' : fmtShort(ts) + ' ') + fmtTime(ts);
}
function fmtWhen(from, to) {
  const day = fmtDay(from);
  return day + ' · ' + fmtTime(from) + '–' + fmtTime(to);
}
function hm(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- tasks ---------------- */

async function loadWorkOnBoot() {
  try { await loadTasks(); } catch { /* not signed in yet */ }
  loadHours();
  // The socket opens a moment after the page, so re-read the clock once it has.
  setTimeout(loadHours, 1500);
}

async function loadTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks || [];
  state.workPeople = data.people || [];
  const sel = $('taskAssignee');
  const keep = sel.value;
  sel.innerHTML = '<option value="">Me</option>';
  for (const p of state.workPeople) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = state.workPeople.some((p) => p.id === keep) ? keep : '';
  renderTasks();
  updateTaskDot();
}

function updateTaskDot() {
  const me = state.me && state.me.id;
  const endOfToday = startOfDay(Date.now()) + 86400000;
  const due = state.tasks.filter((t) => !t.done && t.assigneeId === me && t.dueAt && t.dueAt < endOfToday).length;
  const dot = $('railTasks');
  dot.hidden = !due;
  dot.textContent = String(due || '');
}

function openTasks() {
  $('taskAttachRow').hidden = !state.activeConvId || state.activeKind === 'client';
  if (state.activeConvId && state.activeKind !== 'client') {
    $('taskAttachLabel').textContent = 'Pin to "' + $('chatName').textContent + '"';
  }
  openModal('tasksModal');
  loadTasks().catch((err) => toast(err.message || 'Could not load tasks'));
}

function taskMatches(t, filter) {
  const me = state.me && state.me.id;
  if (filter === 'done') return t.done;
  if (t.done) return false;
  if (filter === 'mine') return t.createdBy === me;
  if (filter === 'assigned') return t.assigneeId === me;
  return true;
}

function taskRow(t) {
  const me = state.me && state.me.id;
  const row = el('div', 'task-row' + (t.done ? ' done' : ''));
  const check = el('button', 'task-check', t.done ? '✓' : '');
  check.title = t.done ? 'Mark as not done' : 'Mark as done';
  check.addEventListener('click', async () => {
    const res = await api('/api/tasks/' + t.id, { method: 'PATCH', body: JSON.stringify({ done: !t.done }) });
    if (res.error) return toast(res.error);
    await loadTasks();
  });

  const main = el('div', 'task-main');
  main.appendChild(el('div', 'task-title', esc(t.title)));
  const meta = el('div', 'task-meta');
  const who = t.assignee ? (t.assigneeId === me ? 'Me' : t.assignee) : 'Nobody';
  meta.appendChild(el('span', '', 'For ' + esc(who)));
  if (t.dueAt) {
    const late = !t.done && t.dueAt < Date.now();
    meta.appendChild(el('span', late ? 'late' : '', (late ? 'Overdue · ' : 'Due ') + esc(fmtDue(t.dueAt))));
  }
  if (t.priority === 'high') meta.appendChild(el('span', 'high', 'High'));
  if (t.conversationTitle) meta.appendChild(el('span', '', '#' + esc(t.conversationTitle)));
  else if (t.createdBy !== me) meta.appendChild(el('span', '', 'From ' + esc(t.creator || 'someone')));
  main.appendChild(meta);
  if (t.notes) {
    const n = el('div', 'task-meta');
    n.appendChild(el('span', '', esc(t.notes)));
    main.appendChild(n);
  }

  const actions = el('div', 'task-actions');
  if (t.conversationId) {
    const chat = el('button', 'btn tiny', 'Chat');
    chat.addEventListener('click', async () => {
      closeModal('tasksModal');
      await refresh().catch(() => {});
      openByConversationId(t.conversationId);
    });
    actions.appendChild(chat);
  } else {
    const chat = el('button', 'btn tiny', 'Start chat');
    chat.title = 'Make a group chat for this task';
    chat.addEventListener('click', async () => {
      const res = await api(`/api/tasks/${t.id}/chat`, { method: 'POST', body: JSON.stringify({}) });
      if (res.error) return toast(res.error);
      closeModal('tasksModal');
      await refresh().catch(() => {});
      openByConversationId(res.conversationId);
    });
    actions.appendChild(chat);
  }
  if (t.createdBy === me) {
    const del = el('button', 'btn tiny danger', 'Delete');
    del.addEventListener('click', async () => {
      if (!(await askConfirm('Delete task', 'This removes the task for everyone it was shared with.', 'delete', 'Delete task'))) return;
      const res = await api('/api/tasks/' + t.id, { method: 'DELETE' });
      if (res.error) return toast(res.error);
      await loadTasks();
    });
    actions.appendChild(del);
  }

  row.append(check, main, actions);
  return row;
}

function renderTasks() {
  const host = $('taskList');
  host.innerHTML = '';
  const list = state.tasks.filter((t) => taskMatches(t, state.taskFilter));
  if (!list.length) {
    const text = state.taskFilter === 'done' ? 'Nothing finished yet.'
      : state.taskFilter === 'assigned' ? 'Nothing has been given to you.'
        : state.taskFilter === 'mine' ? 'You have not made any tasks yet.'
          : 'No open tasks. Enjoy the quiet.';
    host.appendChild(el('div', 'task-empty', text));
    return;
  }
  for (const t of list) host.appendChild(taskRow(t));
}

async function addTask() {
  const title = $('taskTitle').value.trim();
  if (!title) return toast('Give the task a name.');
  const dueRaw = $('taskDue').value;
  const body = {
    title,
    dueAt: dueRaw ? new Date(dueRaw).getTime() : null,
    priority: $('taskHigh').checked ? 'high' : 'normal',
    assigneeId: $('taskAssignee').value || null,
  };
  if ($('taskAttach').checked && state.activeConvId && state.activeKind !== 'client') {
    body.conversationId = state.activeConvId;
  }
  const res = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
  if (res.error) return toast(res.error);
  $('taskTitle').value = '';
  $('taskDue').value = '';
  $('taskHigh').checked = false;
  $('taskAttach').checked = false;
  await loadTasks();
  toast(body.assigneeId ? 'Task assigned' : 'Task added');
}

/* ---------------- calendar ---------------- */

function calDays() {
  const anchor = startOfDay(state.calAnchor || Date.now());
  if (state.calMode === 'day') return [anchor];
  const mon = mondayOf(anchor);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => mon + i * 86400000);
}

async function openCalendar() {
  if (!state.calAnchor) state.calAnchor = startOfDay(Date.now());
  openModal('calModal');
  await loadCalendar().catch((err) => toast(err.message || 'Could not load the calendar'));
}

async function loadCalendar() {
  const days = calDays();
  const from = days[0];
  const to = days[days.length - 1] + 86400000;
  const jobs = [api(`/api/events?from=${from}&to=${to}`), api('/api/tasks')];
  if (moduleOn('leave')) jobs.push(api('/api/leave'));
  const [ev, tk, lvRaw] = await Promise.all(jobs);
  const lv = lvRaw || { mine: [], team: [], holidays: [] };
  state.events = ev.events || [];
  state.workPeople = ev.people || state.workPeople;
  state.leave = lv || state.leave;
  state.tasks = tk.tasks || state.tasks;
  updateTaskDot();
  renderCalendar();
}

function calItem(cls, title, sub, onClick) {
  const b = el('button', 'cal-item ' + cls);
  b.appendChild(el('span', 't', esc(title)));
  if (sub) b.appendChild(el('span', 'h', esc(sub)));
  b.addEventListener('click', onClick);
  return b;
}

function renderCalendar() {
  const days = calDays();
  const grid = $('calGrid');
  grid.className = 'cal-grid ' + state.calMode;
  grid.innerHTML = '';
  const a = new Date(days[0]);
  const b = new Date(days[days.length - 1]);
  $('calTitle').textContent = state.calMode === 'day'
    ? a.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : `${a.getDate()} ${a.toLocaleDateString([], { month: 'short' })} – ${b.getDate()} ${b.toLocaleDateString([], { month: 'short' })} ${b.getFullYear()}`;
  $('calDayBtn').classList.toggle('on', state.calMode === 'day');
  $('calWeekBtn').classList.toggle('on', state.calMode === 'week');

  const today = startOfDay(Date.now());
  for (const dayStart of days) {
    const dayEnd = dayStart + 86400000;
    const key = ymd(dayStart);
    const col = el('div', 'cal-col' + (dayStart === today ? ' today' : ''));
    const head = el('div', 'cal-dayhead');
    head.appendChild(el('span', 'cal-dayname', new Date(dayStart).toLocaleDateString([], { weekday: 'short' })));
    head.appendChild(el('span', 'cal-daynum', String(new Date(dayStart).getDate())));
    // A day card is a place to put something, not just a label.
    const add = el('button', 'cal-add', '+');
    add.type = 'button';
    add.title = 'Add a meeting on this day';
    add.setAttribute('aria-label', 'Add a meeting on this day');
    add.addEventListener('click', (event) => { event.stopPropagation(); openMeetingOn(dayStart); });
    head.appendChild(add);
    col.appendChild(head);
    col.addEventListener('click', (event) => {
      if (event.target.closest('.cal-item') || event.target.closest('.cal-add')) return;
      openMeetingOn(dayStart);
    });

    let count = 0;
    for (const h of state.leave.holidays || []) {
      if (h.day === key) { col.appendChild(calItem('holiday', h.name, 'Public holiday', () => {})); count++; }
    }
    for (const l of state.leave.team || []) {
      if (l.startsOn <= key && l.endsOn >= key) {
        col.appendChild(calItem('leave', l.name + ' is off', l.kind === 'sick' ? 'Sick leave' : 'Time off', () => openLeave()));
        count++;
      }
    }
    const evs = state.events
      .filter((e) => !e.cancelled && e.startsAt < dayEnd && e.endsAt > dayStart)
      .sort((x, y) => x.startsAt - y.startsAt);
    for (const e of evs) {
      const sub = hm(e.startsAt) + (e.location ? ' · ' + e.location : '');
      const cls = 'meeting' + (e.mine ? ' organiser' : '') + (e.myStatus === 'declined' ? ' declined' : '');
      col.appendChild(calItem(cls, e.title, sub, () => openEvent(e)));
      count++;
    }
    const tasks = state.tasks
      .filter((t) => t.dueAt && t.dueAt >= dayStart && t.dueAt < dayEnd)
      .sort((x, y) => x.dueAt - y.dueAt);
    for (const t of tasks) {
      col.appendChild(calItem('task' + (t.done ? ' done' : ''), t.title, 'Task · ' + (t.assignee || 'unassigned'), () => openTasks()));
      count++;
    }
    if (!count) col.appendChild(el('div', 'cal-empty', '—'));
    grid.appendChild(col);
  }
}

async function calShift(dir) {
  state.calAnchor = startOfDay(state.calAnchor || Date.now()) + dir * (state.calMode === 'day' ? 86400000 : 7 * 86400000);
  await loadCalendar();
}

async function setCalMode(mode) {
  state.calMode = mode;
  await loadCalendar();
}

function fillMeetPeople(selected) {
  const host = $('meetPeople');
  host.innerHTML = '';
  if (!state.workPeople.length) {
    host.appendChild(el('div', 'hint', 'No colleagues yet.'));
    return;
  }
  const set = new Set(selected || []);
  for (const p of state.workPeople) {
    const row = el('label', 'pick-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    cb.checked = set.has(p.id);
    row.append(cb, el('span', 'pick-name', esc(p.name)));
    host.appendChild(row);
  }
}

async function openMeetingOn(dayStart) {
  state.calAnchor = startOfDay(dayStart);
  openMeeting(null);
  $('meetDate').value = ymd(dayStart);
}

function openMeeting(ev) {
  state.editEventId = ev ? ev.id : null;
  $('meetTitle').textContent = ev ? 'Edit meeting' : 'New meeting';
  const base = ev ? ev.startsAt : (state.calAnchor || Date.now());
  const date = ymd(ev ? ev.startsAt : base);
  $('meetName').value = ev ? ev.title : '';
  $('meetDate').value = date;
  $('meetPlace').value = ev ? ev.location : '';
  $('meetNotes').value = ev ? ev.notes : '';
  $('meetFrom').value = ev ? hm(ev.startsAt) : '09:00';
  $('meetTo').value = ev ? hm(ev.endsAt) : '09:30';
  $('meetChat').checked = ev ? !!ev.conversationId : true;
  $('meetChat').disabled = !!ev;
  fillMeetPeople(ev ? ev.attendees.map((a) => a.userId).filter((uid) => uid !== (state.me && state.me.id)) : []);
  openModal('meetModal');
  $('meetName').focus();
}

async function saveMeeting() {
  const title = $('meetName').value.trim();
  if (!title) return toast('Give the meeting a name.');
  const date = $('meetDate').value;
  if (!date) return toast('Pick a date.');
  const from = $('meetFrom').value || '09:00';
  const to = $('meetTo').value || '09:30';
  const startsAt = new Date(`${date}T${from}`).getTime();
  const endsAt = new Date(`${date}T${to}`).getTime();
  if (endsAt <= startsAt) return toast('The meeting must end after it starts.');
  const inviteeIds = [...document.querySelectorAll('#meetPeople input:checked')].map((c) => c.value);
  const body = {
    title,
    startsAt,
    endsAt,
    location: $('meetPlace').value.trim(),
    notes: $('meetNotes').value.trim(),
    inviteeIds,
  };
  if (!state.editEventId) body.withChat = $('meetChat').checked;
  const editing = state.editEventId;
  const res = editing
    ? await api('/api/events/' + editing, { method: 'PATCH', body: JSON.stringify(body) })
    : await api('/api/events', { method: 'POST', body: JSON.stringify(body) });
  if (res.error) return toast(res.error);
  state.editEventId = null;
  closeModal('meetModal');
  toast(editing ? 'Meeting updated' : 'Meeting created');
  if (editing) await refresh().catch(() => {});
  await loadCalendar();
}

function eventPerson(a) {
  const p = el('span', 'ev-person ' + a.status);
  p.appendChild(el('span', '', esc(a.name)));
  const label = a.status === 'maybe' ? 'maybe' : a.status;
  p.appendChild(el('span', 'st', label));
  return p;
}

function openEvent(ev) {
  state.openEvent = ev;
  const me = state.me && state.me.id;
  $('eventTitle').textContent = ev.title;
  const body = $('eventBody');
  body.innerHTML = '';
  const row = (k, v) => {
    const r = el('div', 'ev-row');
    r.appendChild(el('div', 'k', k));
    r.appendChild(el('div', '', v));
    body.appendChild(r);
  };
  row('When', esc(fmtWhen(ev.startsAt, ev.endsAt)));
  if (ev.location) row('Where', esc(ev.location));
  row('Organiser', esc(ev.creator || ''));
  if (ev.notes) row('Agenda', esc(ev.notes));
  const people = el('div', 'ev-people');
  for (const a of ev.attendees) people.appendChild(eventPerson(a));
  const prow = el('div', 'ev-row');
  prow.appendChild(el('div', 'k', 'People'));
  prow.appendChild(people);
  body.appendChild(prow);
  if (ev.cancelled) body.appendChild(el('div', 'note', 'This meeting was cancelled.'));

  const foot = $('eventFoot');
  foot.innerHTML = '';
  const close = el('button', 'btn', 'Close');
  close.addEventListener('click', () => closeModal('eventModal'));
  foot.appendChild(close);

  const right = el('div', 'right');
  const chatBtn = el('button', 'btn ghost', ev.conversationId ? 'Open chat' : 'Start chat');
  chatBtn.addEventListener('click', async () => {
    const res = await api(`/api/events/${ev.id}/chat`, { method: 'POST', body: JSON.stringify({}) });
    if (res.error) return toast(res.error);
    closeModal('eventModal');
    await refresh().catch(() => {});
    openByConversationId(res.conversationId);
  });
  if (!ev.cancelled) right.appendChild(chatBtn);

  if (!ev.cancelled && ev.createdBy === me) {
    const edit = el('button', 'btn ghost', 'Edit');
    edit.addEventListener('click', () => { closeModal('eventModal'); openMeeting(ev); });
    right.appendChild(edit);
    const cancel = el('button', 'btn danger', 'Cancel meeting');
    cancel.addEventListener('click', async () => {
      if (!(await askConfirm('Cancel meeting', 'Everyone invited will be told it is off.', 'cancel', 'Cancel meeting'))) return;
      const res = await api('/api/events/' + ev.id, { method: 'DELETE' });
      if (res.error) return toast(res.error);
      closeModal('eventModal');
      toast('Meeting cancelled');
      await loadCalendar();
    });
    right.appendChild(cancel);
  }

  if (!ev.cancelled && ev.createdBy !== me) {
    for (const opt of [['accepted', 'Going'], ['maybe', 'Maybe'], ['declined', 'Cannot go']]) {
      const b = el('button', 'btn' + (ev.myStatus === opt[0] ? ' primary' : ' ghost'), opt[1]);
      b.addEventListener('click', async () => {
        const res = await api(`/api/events/${ev.id}/respond`, { method: 'POST', body: JSON.stringify({ status: opt[0] }) });
        if (res.error) return toast(res.error);
        state.openEvent = res.event;
        openEvent(res.event);
        await loadCalendar();
      });
      right.appendChild(b);
    }
  }
  foot.appendChild(right);
  openModal('eventModal');
}

async function showCalendarFeed() {
  const box = $('calFeedBox');
  const data = await api('/api/calendar/feed');
  if (data.error) return toast(data.error);
  box.innerHTML = '';
  box.hidden = false;
  box.appendChild(el('div', '', 'Paste this address into Google Calendar → Other calendars → From URL:'));
  const row = el('div', 'copyrow');
  row.style.marginTop = '8px';
  const input = document.createElement('input');
  input.readOnly = true;
  input.value = data.url;
  const copy = el('button', 'btn', 'Copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(data.url);
      toast('Address copied');
    } catch {
      input.select();
      toast('Press Ctrl+C to copy');
    }
  });
  row.append(input, copy);
  box.appendChild(row);
}

/* ---------------- time off ---------------- */

async function openLeave() {
  if (!moduleOn('leave')) { toast('Time off is not loaded.'); return; }
  openModal('leaveModal');
  const today = ymd(Date.now());
  if (!$('leaveFrom').value) $('leaveFrom').value = today;
  if (!$('leaveTo').value) $('leaveTo').value = today;
  await loadLeave().catch((err) => toast(err.message || 'Could not load time off'));
}

async function loadLeave() {
  if (!moduleOn('leave')) {
    state.leave = { mine: [], team: [], holidays: [] };
    renderLeave();
    return;
  }
  state.leave = await api('/api/leave');
  renderLeave();
}

const LEAVE_LABEL = { annual: 'Annual leave', sick: 'Sick leave', personal: 'Personal', unpaid: 'Unpaid' };

function renderLeave() {
  const host = $('leaveList');
  host.innerHTML = '';
  const mine = state.leave.mine || [];
  if (!mine.length) host.appendChild(el('div', 'hint', 'You have not asked for any time off yet.'));
  for (const r of mine) {
    const row = el('div', 'leave-row');
    const who = el('div', 'who');
    who.appendChild(el('div', '', esc(LEAVE_LABEL[r.kind] || r.kind) + ' · ' + esc(r.days === 1 ? '1 day' : r.days + ' days')));
    who.appendChild(el('div', 'sub', esc(r.startsOn === r.endsOn ? r.startsOn : r.startsOn + ' → ' + r.endsOn)
      + (r.note ? ' · ' + esc(r.note) : '')));
    row.appendChild(who);
    row.appendChild(el('span', 'leave-badge ' + r.status, r.status));
    if (r.status === 'pending' || r.status === 'approved') {
      const cancel = el('button', 'btn tiny ghost', 'Cancel');
      cancel.addEventListener('click', async () => {
        const res = await api(`/api/leave/${r.id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
        if (res.error) return toast(res.error);
        await loadLeave();
        toast('Request cancelled');
      });
      row.appendChild(cancel);
    }
    host.appendChild(row);
  }

  const team = $('leaveTeam');
  team.innerHTML = '';
  if (!(state.leave.team || []).length) team.appendChild(el('div', 'hint', 'Nobody is off in the coming weeks.'));
  for (const r of state.leave.team || []) {
    const row = el('div', 'leave-row');
    const who = el('div', 'who');
    who.appendChild(el('div', '', esc(r.name)));
    who.appendChild(el('div', 'sub', esc(r.startsOn + ' → ' + r.endsOn) + ' · ' + esc(LEAVE_LABEL[r.kind] || r.kind)));
    row.appendChild(who);
    row.appendChild(el('span', 'leave-badge approved', r.status));
    team.appendChild(row);
  }

  const hol = $('leaveHolidays');
  hol.innerHTML = '';
  if (!(state.leave.holidays || []).length) hol.appendChild(el('div', 'hint', 'No public holidays set.'));
  for (const h of state.leave.holidays || []) {
    const row = el('div', 'leave-row');
    row.appendChild(el('div', 'who', esc(h.name)));
    row.appendChild(el('span', 'leave-badge pending', h.day));
    hol.appendChild(row);
  }
}

async function requestLeave() {
  const from = $('leaveFrom').value;
  const to = $('leaveTo').value || from;
  if (!from) return toast('Pick the first day off.');
  const res = await api('/api/leave', {
    method: 'POST',
    body: JSON.stringify({ kind: $('leaveKind').value, startsOn: from, endsOn: to, reason: $('leaveReason').value.trim() }),
  });
  if (res.error) return toast(res.error);
  $('leaveReason').value = '';
  toast('Request sent' + (res.days ? ' · ' + res.days + (res.days === 1 ? ' day' : ' days') : ''));
  await loadLeave();
}

/* ---------------- the clock ---------------- */

async function loadHours() {
  try {
    state.hours = await api('/api/hours');
  } catch {
    return;
  }
  const chip = $('clockChip');
  chip.classList.toggle('on', !!state.hours.since);
  const worked = fmtMinutes(state.hours.todayMinutes || 0);
  $('clockText').textContent = state.hours.since ? 'Working · ' + worked + ' today' : 'Off the clock · ' + worked + ' today';
}

/* ---------------- live updates ---------------- */

function handleWorkSocket(msg) {
  if (msg.t === 'task' || msg.t === 'task:due') {
    loadTasks().catch(() => {});
    if (msg.t === 'task:due') toast('Task due: ' + msg.title);
    else if (msg.action === 'new' && msg.task && state.me && msg.task.assigneeId === state.me.id) {
      toast('New task: ' + msg.task.title);
    }
    return true;
  }
  if (msg.t === 'event') {
    if (msg.action === 'invite' && msg.event) toast('Meeting invitation: ' + msg.event.title);
    if (msg.action === 'cancel' && msg.title) toast('Meeting cancelled: ' + msg.title);
    if (msg.action === 'update' && msg.event) toast('Meeting changed: ' + msg.event.title);
    if ($('calModal').classList.contains('open')) loadCalendar().catch(() => {});
    return true;
  }
  if (msg.t === 'event:soon') {
    toast('Starting soon: ' + msg.event.title);
    return true;
  }
  if (msg.t === 'leave') {
    if (msg.action === 'request' && state.me && state.me.admin) toast('New time-off request');
    if (msg.action === 'approved') toast('Your time off was approved');
    if (msg.action === 'declined') toast('Your time off was declined');
    if ($('leaveModal').classList.contains('open')) loadLeave().catch(() => {});
    if ($('calModal').classList.contains('open')) loadCalendar().catch(() => {});
    return true;
  }
  return false;
}

/* ---------------- wiring ---------------- */

function wireWork() {
  $('btnTasksRail').addEventListener('click', openTasks);
  $('tasksClose').addEventListener('click', () => closeModal('tasksModal'));
  $('taskAdd').addEventListener('click', () => addTask().catch((e) => toast(e.message)));
  $('taskTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTask().catch((err) => toast(err.message)); }
  });
  for (const b of document.querySelectorAll('[data-tfilter]')) {
    b.addEventListener('click', () => {
      state.taskFilter = b.dataset.tfilter;
      document.querySelectorAll('[data-tfilter]').forEach((x) => x.classList.toggle('active', x === b));
      renderTasks();
    });
  }

  $('btnCalendarRail').addEventListener('click', () => openCalendar().catch((e) => toast(e.message)));
  $('btnLeaveRail').addEventListener('click', () => openLeave().catch((e) => toast(e.message)));
  $('clockChip').addEventListener('click', () => openCalendar().catch((e) => toast(e.message)));
  $('calClose').addEventListener('click', () => closeModal('calModal'));
  $('calPrev').addEventListener('click', () => calShift(-1).catch((e) => toast(e.message)));
  $('calNext').addEventListener('click', () => calShift(1).catch((e) => toast(e.message)));
  $('calToday').addEventListener('click', () => {
    state.calAnchor = startOfDay(Date.now());
    loadCalendar().catch((e) => toast(e.message));
  });
  $('calDayBtn').addEventListener('click', () => setCalMode('day').catch((e) => toast(e.message)));
  $('calWeekBtn').addEventListener('click', () => setCalMode('week').catch((e) => toast(e.message)));
  $('calNew').addEventListener('click', () => openMeeting(null));
  $('calLeave').addEventListener('click', () => openLeave().catch((e) => toast(e.message)));
  $('calFeed').addEventListener('click', () => showCalendarFeed().catch((e) => toast(e.message)));
  $('calDownload').addEventListener('click', () => { location.href = '/api/calendar.ics'; });
  $('calImport').addEventListener('click', () => $('calImportFile').click());
  $('calImportFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const res = await api('/api/calendar/import', { method: 'POST', body: JSON.stringify({ ics: text }) });
    if (res.error) return toast(res.error);
    toast(res.imported ? 'Imported ' + res.imported + (res.imported === 1 ? ' event' : ' events') : 'No events found in that file');
    await loadCalendar();
  });

  $('meetCancel').addEventListener('click', () => { state.editEventId = null; closeModal('meetModal'); });
  $('meetSave').addEventListener('click', () => saveMeeting().catch((e) => toast(e.message)));
  $('eventClose').addEventListener('click', () => closeModal('eventModal'));

  $('leaveClose').addEventListener('click', () => closeModal('leaveModal'));
  $('leaveSend').addEventListener('click', () => requestLeave().catch((e) => toast(e.message)));

  // Clicking the dim area closes these panels, as with the rest of the app's modals.
  for (const id of ['tasksModal', 'calModal', 'meetModal', 'eventModal', 'leaveModal']) {
    const back = $(id);
    back.addEventListener('click', (e) => {
      if (e.target === back) {
        if (id === 'meetModal') state.editEventId = null;
        back.classList.remove('open');
      }
    });
  }
}

/* ---------------- drive ---------------- */

const driveState = { scope: 'mine', roomId: '', parent: '', data: null };

const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>';
const FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';

async function openDrive() {
  openModal('driveModal');
  await loadDrive().catch((e) => toast(e.message));
}

async function loadDrive() {
  const qs = new URLSearchParams({ scope: driveState.scope });
  if (driveState.scope === 'room' && driveState.roomId) qs.set('roomId', driveState.roomId);
  if (driveState.parent) qs.set('parent', driveState.parent);
  let data = await api('/api/drive?' + qs.toString());
  if (data.error && driveState.scope === 'room' && !driveState.roomId) {
    driveState.scope = 'mine';
    data = await api('/api/drive?scope=mine');
  }
  if (data.error) { toast(data.error); return; }
  driveState.data = data;
  driveState.parent = data.parentId || '';
  if (driveState.scope === 'room' && !driveState.roomId) driveState.roomId = data.roomId || '';
  renderDrive();
}

function renderDrive() {
  const d = driveState.data;
  if (!d) return;
  $('driveMineBtn').classList.toggle('on', d.scope === 'mine');
  $('driveRoomBtn').classList.toggle('on', d.scope === 'room');

  const pick = $('driveRoomPick');
  pick.hidden = d.scope !== 'room';
  pick.innerHTML = '';
  for (const r of d.rooms || []) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.name;
    pick.appendChild(o);
  }
  if (d.scope === 'room' && d.roomId) pick.value = d.roomId;

  const crumbs = $('driveCrumbs');
  crumbs.innerHTML = '';
  const root = el('button', 'drive-crumb' + (d.crumbs.length ? '' : ' on'),
    esc(d.scope === 'room' ? ((d.rooms.find((r) => r.id === d.roomId) || {}).name || 'Room drive') : 'My Drive'));
  root.addEventListener('click', () => { driveState.parent = ''; loadDrive().catch((e) => toast(e.message)); });
  crumbs.appendChild(root);
  for (const c of d.crumbs) {
    crumbs.appendChild(el('span', 'hint', '/'));
    const b = el('button', 'drive-crumb' + (c.id === d.parentId ? ' on' : ''), esc(c.name));
    b.addEventListener('click', () => { driveState.parent = c.id; loadDrive().catch((e) => toast(e.message)); });
    crumbs.appendChild(b);
  }

  const host = $('driveList');
  host.innerHTML = '';
  if (!d.items.length) host.appendChild(el('div', 'hint', 'This folder is empty. Use Upload to put a file here.'));

  for (const it of d.items) {
    const row = el('div', 'drive-row');
    const ico = el('div', 'drive-ico' + (it.kind === 'folder' ? ' folder' : ''), it.kind === 'folder' ? FOLDER_ICON : FILE_ICON);
    row.appendChild(ico);

    const what = el('div', 'what');
    const name = el('div', 'nm', esc(it.name));
    name.addEventListener('click', () => {
      if (it.kind === 'folder') { driveState.parent = it.id; loadDrive().catch((e) => toast(e.message)); }
      else location.href = '/api/drive/' + it.id + '/download';
    });
    what.appendChild(name);
    const bits = [];
    if (it.kind === 'file') bits.push(fmtBytes(it.bytes));
    else bits.push('Folder');
    if (it.version > 1) bits.push('v' + it.version);
    if (it.shareCount) bits.push('shared with ' + it.shareCount);
    if (it.sharedWithMe) bits.push('shared with you');
    bits.push(new Date(it.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }));
    what.appendChild(el('div', 'meta', esc(bits.join(' \u00b7 '))));
    row.appendChild(what);

    const acts = el('div', 'acts');
    if (it.kind === 'file') {
      const open = el('button', 'btn tiny ghost', 'Download');
      open.addEventListener('click', () => { location.href = '/api/drive/' + it.id + '/download'; });
      acts.appendChild(open);
      const vers = el('button', 'btn tiny ghost', 'Versions');
      vers.addEventListener('click', () => toggleDriveVersions(row, it));
      acts.appendChild(vers);
    }
    const rename = el('button', 'btn tiny ghost', 'Rename');
    rename.addEventListener('click', async () => {
      const next = await askText('Rename', 'New name', it.name, it.name);
      if (!next) return;
      const res = await api('/api/drive/' + it.id, { method: 'PATCH', body: JSON.stringify({ name: next }) });
      if (res.error) return toast(res.error);
      await loadDrive();
    });
    acts.appendChild(rename);

    if (it.ownerId === (state.me && state.me.id) || !it.conversationId) {
      const share = el('button', 'btn tiny ghost', 'Share');
      share.addEventListener('click', async () => {
        const chosen = await pickPeople('Share ' + it.name, (it.shareCount || 0) > 0);
        if (!chosen) return;
        const res = await api('/api/drive/' + it.id, { method: 'PATCH', body: JSON.stringify({ shareUserIds: chosen }) });
        if (res.error) return toast(res.error);
        toast(chosen.length ? 'Shared with ' + chosen.length + (chosen.length === 1 ? ' person' : ' people') : 'Sharing stopped');
        await loadDrive();
      });
      acts.appendChild(share);
    }

    const del = el('button', 'btn tiny danger ghost', 'Delete');
    del.addEventListener('click', async () => {
      const ok = await askConfirm('Delete', `Delete "${it.name}"` + (it.kind === 'folder' ? ' and everything in it' : '') + '? This cannot be undone.', 'delete', 'Delete');
      if (!ok) return;
      const res = await api('/api/drive/' + it.id, { method: 'DELETE' });
      if (res.error) return toast(res.error);
      toast('Deleted');
      await loadDrive();
    });
    acts.appendChild(del);
    row.appendChild(acts);
    host.appendChild(row);
  }

  const used = d.usage.used;
  const quota = d.usage.quota;
  const pct = Math.min(100, Math.round((used / quota) * 100));
  const usage = $('driveUsage');
  usage.innerHTML = '';
  usage.appendChild(el('span', '', d.scope === 'room'
    ? 'Room drive: ' + esc(fmtBytes(used)) + ' used'
    : 'My Drive: ' + esc(fmtBytes(used)) + ' of ' + esc(fmtBytes(quota))));
  const meter = el('span', 'drive-meter');
  const fill = el('i');
  fill.style.width = pct + '%';
  meter.appendChild(fill);
  usage.appendChild(meter);
}

async function toggleDriveVersions(row, it) {
  const open = row.querySelector('.drive-versions');
  if (open) { open.remove(); return; }
  const data = await api('/api/drive/' + it.id + '/versions');
  if (data.error) return toast(data.error);
  const box = el('div', 'drive-versions');
  for (const v of data.versions) {
    const line = el('div', 'drive-ver');
    line.appendChild(el('span', '', 'v' + v.version + ' \u00b7 ' + esc(fmtBytes(v.bytes)) + ' \u00b7 ' + esc(v.uploadedBy) + ' \u00b7 ' + esc(new Date(v.createdAt).toLocaleString())));
    const dl = el('button', 'btn tiny ghost', 'Download');
    dl.addEventListener('click', () => { location.href = '/api/drive/' + it.id + '/download?version=' + v.version; });
    line.appendChild(dl);
    if (v.version !== it.version) {
      const restore = el('button', 'btn tiny ghost', 'Restore');
      restore.addEventListener('click', async () => {
        const res = await api('/api/drive/' + it.id + '/restore', { method: 'POST', body: JSON.stringify({ version: v.version }) });
        if (res.error) return toast(res.error);
        toast('Restored v' + v.version);
        await loadDrive();
      });
      line.appendChild(restore);
    } else {
      line.appendChild(el('span', 'hint', 'current'));
    }
    box.appendChild(line);
  }
  row.appendChild(box);
}

function pickPeople(title, preselectAll) {
  return new Promise((resolve) => {
    const back = el('div', 'modal-back open');
    const box = el('div', 'modal');
    box.style.maxWidth = '420px';
    box.appendChild(el('div', 'mhead', esc(title)));
    const body = el('div', 'mbody');
    const list = el('div', 'leave-list');
    const picks = [];
    for (const p of state.people) {
      if (p.id === (state.me && state.me.id)) continue;
      const row = el('label', 'pick-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p.id;
      if (preselectAll) cb.checked = true;
      picks.push(cb);
      row.append(cb, el('span', 'pick-name', esc(p.name)));
      list.appendChild(row);
    }
    if (!picks.length) list.appendChild(el('div', 'hint', 'There is nobody else to share with yet.'));
    body.appendChild(list);
    const foot = el('div', 'mfoot');
    const cancel = el('button', 'btn ghost', 'Cancel');
    const ok = el('button', 'btn primary', 'Save');
    foot.append(cancel, ok);
    box.append(body, foot);
    back.appendChild(box);
    document.body.appendChild(back);
    const done = (v) => { back.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => done(picks.filter((c) => c.checked).map((c) => c.value)));
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
  });
}

async function driveUpload(file) {
  if (!file) return;
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'x-filename': encodeURIComponent(file.name),
    'x-scope': driveState.scope,
  };
  if (driveState.scope === 'room') headers['x-room-id'] = driveState.roomId;
  if (driveState.parent) headers['x-parent-id'] = driveState.parent;
  const res = await fetch('/api/drive/upload', { method: 'POST', credentials: 'same-origin', headers, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || 'Could not upload that file'); return; }
  toast('Uploaded ' + file.name);
  await loadDrive();
}

/* ---------------- internal mail ---------------- */

const mailState = { folder: 'inbox', threads: [], current: null, attach: [] };

async function openMail() {
  openModal('mailModal');
  mailState.attach = [];
  mailState.current = null;
  $('mailMain').innerHTML = '';
  $('mailMain').appendChild(el('div', 'hint', 'Pick a message, or write a new one.'));
  await loadMail().catch((e) => toast(e.message));
}

async function loadMail() {
  const data = await api('/api/mail?folder=' + mailState.folder);
  if (data.error) { toast(data.error); return; }
  mailState.threads = data.threads || [];
  $('railMail').hidden = !Number(data.unread || 0);
  renderMailList();
}

function renderMailList() {
  const host = $('mailList');
  host.innerHTML = '';
  if (!mailState.threads.length) {
    host.appendChild(el('div', 'hint', mailState.folder === 'inbox' ? 'No mail yet.' : 'Nothing sent yet.'));
    return;
  }
  for (const t of mailState.threads) {
    const item = el('div', 'mail-item' + (t.unread ? ' unread' : '') + (mailState.current === t.threadId ? ' on' : ''));
    if (t.priority === 'high') item.appendChild(el('div', 'mflag', 'Important'));
    item.appendChild(el('div', 'msub', esc(t.subject)));
    item.appendChild(el('div', 'mfrom', esc(mailState.folder === 'inbox' ? t.fromName : 'To: ' + t.toNames.join(', '))));
    item.appendChild(el('div', 'mprev', esc((t.lastBody || '').slice(0, 70))));
    item.appendChild(el('div', 'mfrom', esc(new Date(t.lastAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))));
    item.addEventListener('click', () => openMailThread(t.threadId).catch((e) => toast(e.message)));
    host.appendChild(item);
  }
}

async function openMailThread(threadId) {
  const data = await api('/api/mail/' + threadId);
  if (data.error) return toast(data.error);
  mailState.current = threadId;
  renderMailList();

  const main = $('mailMain');
  main.innerHTML = '';
  const head = el('div', 'mail-thread-head');
  head.appendChild(el('h3', '', esc(data.subject)));
  const last = data.messages[data.messages.length - 1];
  head.appendChild(el('div', 'sub', esc((last.toNames || []).length ? 'With: ' + [...new Set([...data.messages.map((m) => m.fromName), ...last.toNames])].join(', ') : 'Only you')));
  main.appendChild(head);

  for (const m of data.messages) {
    const box = el('div', 'mail-msg');
    const who = el('div', 'who');
    who.appendChild(el('span', '', esc(m.mine ? 'You' : m.fromName) + (m.mine ? ' \u2192 ' + esc(m.toNames.join(', ')) : '')));
    who.appendChild(el('span', '', esc(new Date(m.createdAt).toLocaleString())));
    box.appendChild(who);
    if (m.priority === 'high') box.appendChild(el('div', 'mflag', 'Important'));
    box.appendChild(el('div', 'txt', esc(m.body)));
    if (m.attachments.length) {
      const atts = el('div', 'atts');
      for (const a of m.attachments) {
        const link = el('a', 'mail-att', esc(a.name) + ' \u00b7 ' + esc(fmtBytes(a.bytes)));
        link.href = '/api/mail/attachments/' + a.id + '/download';
        atts.appendChild(link);
      }
      box.appendChild(atts);
    }
    main.appendChild(box);
  }

  const reply = el('div', 'mail-reply');
  const ta = document.createElement('textarea');
  ta.placeholder = 'Reply';
  const send = el('button', 'btn primary', 'Reply');
  send.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) return toast('Write something first');
    const res = await api('/api/mail/' + threadId + '/reply', { method: 'POST', body: JSON.stringify({ body: text }) });
    if (res.error) return toast(res.error);
    await openMailThread(threadId);
    toast('Reply sent');
  });
  reply.append(ta, send);
  main.appendChild(reply);

  const tools = el('div', 'ev-actions');
  tools.style.marginTop = '10px';
  const del = el('button', 'btn tiny ghost', 'Move to bin');
  del.addEventListener('click', async () => {
    const res = await api('/api/mail/' + threadId, { method: 'DELETE' });
    if (res.error) return toast(res.error);
    mailState.current = null;
    $('mailMain').innerHTML = '';
    $('mailMain').appendChild(el('div', 'hint', 'Pick a message, or write a new one.'));
    await loadMail();
    toast('Removed from your mail');
  });
  tools.appendChild(del);
  main.appendChild(tools);
}

function mailCompose() {
  mailState.current = null;
  mailState.attach = [];
  renderMailList();
  const main = $('mailMain');
  main.innerHTML = '';
  const form = el('div', 'mail-compose');
  form.appendChild(el('div', 'mhead', 'New mail')).style.marginTop = '-4px';

  form.appendChild(el('label', '', 'To'));
  const picks = el('div', 'mail-picks');
  const selected = new Set();
  for (const p of state.people) {
    if (p.id === (state.me && state.me.id)) continue;
    const b = el('button', 'mail-pick', esc(p.name));
    b.type = 'button';
    b.addEventListener('click', () => {
      if (selected.has(p.id)) { selected.delete(p.id); b.classList.remove('on'); }
      else { selected.add(p.id); b.classList.add('on'); }
    });
    picks.appendChild(b);
  }
  form.appendChild(picks);

  form.appendChild(el('label', '', 'Subject'));
  const subj = document.createElement('input');
  subj.placeholder = 'What is this about?';
  form.appendChild(subj);

  form.appendChild(el('label', '', 'Priority'));
  const prio = document.createElement('select');
  prio.innerHTML = '<option value="normal">Normal</option><option value="high">Important</option>';
  form.appendChild(prio);

  form.appendChild(el('label', '', 'Message'));
  const body = document.createElement('textarea');
  body.placeholder = 'Write your message';
  form.appendChild(body);

  const attRow = el('div', 'mail-picks');
  const attachBtn = el('button', 'btn tiny ghost', 'Attach a file');
  attachBtn.type = 'button';
  const attFile = document.createElement('input');
  attFile.type = 'file';
  attFile.hidden = true;
  attachBtn.addEventListener('click', () => attFile.click());
  attRow.append(attachBtn, attFile);
  const attList = el('div', 'mail-picks');
  attFile.addEventListener('change', async () => {
    const file = attFile.files && attFile.files[0];
    attFile.value = '';
    if (!file) return;
    const headers = {
      'Content-Type': file.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name), 'x-scope': 'mine',
    };
    const res = await fetch('/api/drive/upload', { method: 'POST', credentials: 'same-origin', headers, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'Could not attach that file');
    mailState.attach.push({ id: data.item.id, name: data.item.name, bytes: data.item.bytes });
    attList.innerHTML = '';
    for (const a of mailState.attach) attList.appendChild(el('span', 'mail-att', esc(a.name)));
  });
  form.append(attRow, attList);

  const send = el('button', 'btn primary', 'Send');
  send.addEventListener('click', async () => {
    if (!selected.size) return toast('Pick at least one person');
    if (!body.value.trim() && !mailState.attach.length) return toast('Write something first');
    const res = await api('/api/mail', {
      method: 'POST',
      body: JSON.stringify({
        to: [...selected], subject: subj.value, body: body.value,
        priority: prio.value, attachmentIds: mailState.attach.map((a) => a.id),
      }),
    });
    if (res.error) return toast(res.error);
    toast('Mail sent');
    mailState.folder = 'sent';
    for (const b of document.querySelectorAll('[data-mfolder]')) b.classList.toggle('on', b.dataset.mfolder === 'sent');
    mailState.current = null;
    $('mailMain').innerHTML = '';
    $('mailMain').appendChild(el('div', 'hint', 'Pick a message, or write a new one.'));
    await loadMail();
    await openMailThread(res.mail.threadId);
  });
  form.appendChild(send);
  main.appendChild(form);
}

/* ---------------- helpdesk ---------------- */

const helpState = { status: '', tickets: [] };

async function openHelpdesk() {
  openModal('helpModal');
  $('railHelp').hidden = true;
  await loadTickets().catch((e) => toast(e.message));
}

async function loadTickets() {
  const data = await api('/api/tickets' + (helpState.status ? '?status=' + helpState.status : ''));
  if (data.error) { toast(data.error); return; }
  helpState.tickets = data.tickets || [];
  renderTickets();
}

function renderTickets() {
  const host = $('helpList');
  host.innerHTML = '';
  if (!helpState.tickets.length) {
    host.appendChild(el('div', 'hint', 'No tickets here. A ticket is created for every customer chat.'));
    return;
  }
  for (const t of helpState.tickets) {
    const row = el('div', 'help-row' + (t.waiting ? ' waiting' : ''));
    const who = el('div', 'who');
    const title = el('div', 'nm', esc(t.clientName) + ' \u00b7 ' + esc(t.subject));
    if (t.priority === 'high') title.appendChild(el('span', 'help-prio', ' \u00b7 important'));
    who.appendChild(title);
    who.appendChild(el('div', 'sub', esc((t.lastBody || '').slice(0, 90))));
    who.appendChild(el('div', 'sub', esc(t.assigneeName ? 'Owner: ' + t.assigneeName : 'Nobody owns it yet')
      + ' \u00b7 ' + esc(new Date(t.lastAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
      + (t.online ? ' \u00b7 online now' : '')));
    row.appendChild(who);
    row.appendChild(el('span', 'help-status ' + t.status, t.status === 'pending' ? 'waiting' : t.status));

    const controls = el('div', 'controls');
    const status = document.createElement('select');
    status.innerHTML = '<option value="open">Open</option><option value="pending">Waiting</option><option value="resolved">Resolved</option>';
    status.value = t.status;
    status.addEventListener('change', async () => {
      const res = await api('/api/tickets/' + t.id, { method: 'PATCH', body: JSON.stringify({ status: status.value }) });
      if (res.error) return toast(res.error);
      toast('Ticket ' + status.value);
      await loadTickets();
    });
    controls.appendChild(status);

    const prio = document.createElement('select');
    prio.innerHTML = '<option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>';
    prio.value = t.priority;
    prio.addEventListener('change', async () => {
      const res = await api('/api/tickets/' + t.id, { method: 'PATCH', body: JSON.stringify({ priority: prio.value }) });
      if (res.error) return toast(res.error);
      toast('Priority ' + prio.value);
      await loadTickets();
    });
    controls.appendChild(prio);

    const owner = document.createElement('select');
    owner.innerHTML = '<option value="">Nobody</option>' + state.people
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    owner.value = t.assigneeId || '';
    owner.addEventListener('change', async () => {
      const res = await api('/api/tickets/' + t.id, { method: 'PATCH', body: JSON.stringify({ assigneeId: owner.value }) });
      if (res.error) return toast(res.error);
      toast('Ticket assigned');
      await loadTickets();
    });
    controls.appendChild(owner);

    const open = el('button', 'btn tiny primary', 'Open chat');
    open.addEventListener('click', async () => {
      closeModal('helpModal');
      await refresh();
      const contact = state.contacts.find((c) => c.conversationId === t.conversationId);
      if (contact) openConversation(contact);
      else toast('That chat is no longer here');
    });
    controls.appendChild(open);
    row.appendChild(controls);
    host.appendChild(row);
  }
}

function handlePhase5Socket(msg) {
  if (msg.t === 'mail') {
    toast('Mail from ' + (msg.fromName || 'someone') + ': ' + (msg.subject || ''));
    if (moduleOn('mail')) $('railMail').hidden = false;
    if ($('mailModal').classList.contains('open')) loadMail().catch(() => {});
    return true;
  }
  if (msg.t === 'ticket') {
    if (state.me && state.me.admin && moduleOn('helpdesk')) {
      $('railHelp').hidden = false;
      if ($('helpModal').classList.contains('open')) loadTickets().catch(() => {});
    }
    return true;
  }
  if (msg.t === 'drive') {
    toast(msg.name ? 'Shared with you: ' + msg.name : 'A file was shared with you');
    if ($('driveModal').classList.contains('open')) loadDrive().catch(() => {});
    return true;
  }
  return false;
}

/* ---------------- two-factor ---------------- */

async function loadTwofa() {
  const s = await api('/api/2fa');
  $('twofaStartBox').hidden = !!s.enabled;
  $('twofaStep2').hidden = true;
  $('twofaOnBox').hidden = !s.enabled;
  if (s.required && !s.enabled) {
    $('twofaHint').textContent = 'Your administrator requires two-factor sign-in.';
  } else if (!$('twofaHint').textContent) {
    $('twofaHint').textContent = '';
  }
}

async function openSecurity() {
  openModal('twofaModal');
  $('twofaHint').textContent = '';
  await loadTwofa().catch((e) => toast(e.message));
}

async function startTwofa() {
  const res = await api('/api/2fa/start', { method: 'POST', body: JSON.stringify({}) });
  if (res.error) return toast(res.error);
  $('twofaSecret').textContent = res.secret;
  $('twofaStep2').hidden = false;
  $('twofaStartBox').hidden = true;
  $('twofaCode').value = '';
  $('twofaCode').focus();
}

async function confirmTwofa() {
  const code = $('twofaCode').value.replace(/\D/g, '');
  if (code.length !== 6) return toast('The code is six digits');
  const res = await api('/api/2fa/confirm', { method: 'POST', body: JSON.stringify({ code }) });
  if (res.error) return toast(res.error);
  toast('Two-factor sign-in is on');
  await refresh();
  if (state.me && !state.me.needs2fa) closeModal('twofaModal');
  await loadTwofa().catch(() => {});
  if (state.me && state.me.needs2fa) location.reload();
}

async function disableTwofa() {
  const password = $('twofaPassword').value;
  if (!password) return toast('Type your password to turn it off');
  const res = await api('/api/2fa/disable', { method: 'POST', body: JSON.stringify({ password }) });
  if (res.error) return toast(res.error);
  $('twofaPassword').value = '';
  toast('Two-factor sign-in is off');
  await loadTwofa().catch(() => {});
}

function wireSecurity() {
  $('btnSecurity').addEventListener('click', () => openSecurity().catch((e) => toast(e.message)));
  $('twofaStart').addEventListener('click', () => startTwofa().catch((e) => toast(e.message)));
  $('twofaConfirm').addEventListener('click', () => confirmTwofa().catch((e) => toast(e.message)));
  $('twofaDisable').addEventListener('click', () => disableTwofa().catch((e) => toast(e.message)));
  $('twofaClose').addEventListener('click', () => {
    if (state.me && state.me.needs2fa) return toast('Set up two-factor first, or sign out');
    closeModal('twofaModal');
  });
  $('twofaCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('twofaConfirm').click(); });
  const back = $('twofaModal');
  back.addEventListener('click', (e) => {
    if (e.target === back && !(state.me && state.me.needs2fa)) back.classList.remove('open');
  });
}

wireSecurity();

function wirePhase5() {
  $('btnDriveRail').addEventListener('click', () => openDrive().catch((e) => toast(e.message)));
  $('btnMailRail').addEventListener('click', () => openMail().catch((e) => toast(e.message)));
  $('btnHelpRail').addEventListener('click', () => openHelpdesk().catch((e) => toast(e.message)));
  $('driveClose').addEventListener('click', () => closeModal('driveModal'));
  $('mailClose').addEventListener('click', () => closeModal('mailModal'));
  $('helpClose').addEventListener('click', () => closeModal('helpModal'));

  $('driveMineBtn').addEventListener('click', () => {
    driveState.scope = 'mine'; driveState.parent = ''; loadDrive().catch((e) => toast(e.message));
  });
  $('driveRoomBtn').addEventListener('click', () => {
    driveState.scope = 'room'; driveState.parent = ''; loadDrive().catch((e) => toast(e.message));
  });
  $('driveRoomPick').addEventListener('change', (e) => {
    driveState.roomId = e.target.value; driveState.parent = ''; loadDrive().catch((err) => toast(err.message));
  });
  $('driveUploadBtn').addEventListener('click', () => $('driveFile').click());
  $('driveFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    await driveUpload(file);
  });
  $('driveNewFolder').addEventListener('click', async () => {
    const name = await askText('New folder', 'Folder name', 'Reports');
    if (!name) return;
    const res = await api('/api/drive/folder', {
      method: 'POST',
      body: JSON.stringify({ name, scope: driveState.scope, roomId: driveState.roomId, parentId: driveState.parent || null }),
    });
    if (res.error) return toast(res.error);
    await loadDrive();
  });

  for (const b of document.querySelectorAll('[data-mfolder]')) {
    b.addEventListener('click', () => {
      mailState.folder = b.dataset.mfolder;
      for (const other of document.querySelectorAll('[data-mfolder]')) other.classList.toggle('on', other === b);
      mailState.current = null;
      $('mailMain').innerHTML = '';
      $('mailMain').appendChild(el('div', 'hint', 'Pick a message, or write a new one.'));
      loadMail().catch((e) => toast(e.message));
    });
  }
  $('mailWrite').addEventListener('click', () => mailCompose());

  for (const b of document.querySelectorAll('[data-hstatus]')) {
    b.addEventListener('click', () => {
      helpState.status = b.dataset.hstatus;
      for (const other of document.querySelectorAll('[data-hstatus]')) other.classList.toggle('on', other === b);
      loadTickets().catch((e) => toast(e.message));
    });
  }

  for (const id of ['driveModal', 'mailModal', 'helpModal']) {
    const back = $(id);
    back.addEventListener('click', (e) => { if (e.target === back) back.classList.remove('open'); });
  }
}

wirePhase5();

wireWork();
setInterval(() => { loadHours(); }, 60000);


boot().catch((err) => {
  console.error(err);
});

/* ---------------- Peach Wall ---------------- */
let wallData = null;

function wEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function wallWhen(ms) {
  const d = new Date(Number(ms) || Date.now());
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
}

async function wallReq(path, method, payload) {
  const res = await fetch(path, {
    method: method || 'GET',
    credentials: 'same-origin',
    headers: payload ? { 'Content-Type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
  return data || {};
}

async function openWall() {
  openModal('wallModal');
  await loadWall();
}

async function loadWall() {
  wallData = await wallReq('/api/wall');
  renderWall();
}

function renderWall() {
  const host = $('wallList');
  if (!host) return;
  host.innerHTML = '';
  const posts = (wallData && wallData.posts) || [];
  const admin = !!(wallData && wallData.admin);
  if (!posts.length) {
    host.appendChild(wEl('div', 'hint', 'The wall is empty. Post the first thing.'));
    return;
  }
  for (const p of posts) {
    const card = wEl('div', 'wall-post');
    const head = wEl('div', 'wall-head');
    head.appendChild(wEl('span', 'wall-author', p.author));
    if (p.department) head.appendChild(wEl('span', 'wall-dept', p.department));
    head.appendChild(wEl('span', 'wall-time', wallWhen(p.createdAt)));
    if (p.mine || admin) {
      const del = wEl('button', 'wall-del', 'Delete');
      del.title = 'Remove this post and its replies';
      del.addEventListener('click', async () => {
        if (!window.confirm('Remove this post and its replies?')) return;
        try { await wallReq('/api/wall/remove', 'POST', { kind: 'post', id: p.id }); await loadWall(); }
        catch (e) { toast(e.message); }
      });
      head.appendChild(del);
    }
    card.appendChild(head);
    card.appendChild(wEl('div', 'wall-body', p.body));

    const foot = wEl('div', 'wall-foot');
    const like = wEl('button', 'wall-like' + (p.liked ? ' on' : ''), (p.liked ? '♥ ' : '♡ ') + (p.likes || 'Like'));
    like.title = p.liked ? 'Take your like back' : 'Like this';
    like.addEventListener('click', async () => {
      try { await wallReq('/api/wall/like', 'POST', { id: p.id }); await loadWall(); }
      catch (e) { toast(e.message); }
    });
    foot.appendChild(like);
    const count = (p.comments || []).length;
    foot.appendChild(wEl('span', 'wall-count', count ? (count + (count === 1 ? ' reply' : ' replies')) : 'No replies'));
    card.appendChild(foot);

    for (const c of p.comments || []) {
      const row = wEl('div', 'wall-comment');
      const chead = wEl('div', 'wall-chead');
      chead.appendChild(wEl('span', 'wall-author', c.author));
      chead.appendChild(wEl('span', 'wall-time', wallWhen(c.createdAt)));
      if (c.mine || admin) {
        const del = wEl('button', 'wall-del', 'Delete');
        del.addEventListener('click', async () => {
          try { await wallReq('/api/wall/remove', 'POST', { kind: 'comment', id: c.id }); await loadWall(); }
          catch (e) { toast(e.message); }
        });
        chead.appendChild(del);
      }
      row.appendChild(chead);
      row.appendChild(wEl('div', 'wall-cbody', c.body));
      card.appendChild(row);
    }

    const reply = wEl('div', 'wall-reply');
    const input = document.createElement('input');
    input.placeholder = 'Reply…';
    input.maxLength = 1000;
    const send = wEl('button', 'btn small', 'Reply');
    const doReply = async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      send.disabled = true;
      try {
        await wallReq('/api/wall/comment', 'POST', { id: p.id, body: text });
        input.value = '';
        await loadWall();
      } catch (e) { toast(e.message); }
      finally { send.disabled = false; }
    };
    send.addEventListener('click', doReply);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doReply(); } });
    reply.append(input, send);
    card.appendChild(reply);

    host.appendChild(card);
  }
}

const wallRailBtn = $('btnWallRail');
if (wallRailBtn) wallRailBtn.addEventListener('click', () => openWall().catch((e) => toast(e.message)));
const wallPostBtn = $('wallPost');
if (wallPostBtn) {
  wallPostBtn.addEventListener('click', async () => {
    const input = $('wallInput');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    wallPostBtn.disabled = true;
    try { await wallReq('/api/wall', 'POST', { body: text }); input.value = ''; await loadWall(); }
    catch (e) { toast(e.message); }
    finally { wallPostBtn.disabled = false; }
  });
}
const wallCloseBtn = $('wallClose');
if (wallCloseBtn) wallCloseBtn.addEventListener('click', () => closeModal('wallModal'));
