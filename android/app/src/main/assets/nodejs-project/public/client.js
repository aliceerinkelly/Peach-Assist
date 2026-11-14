/* Client thread */
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
  convId: null,
  messages: [],
  lastSeq: 0,
  opReadSeq: 0,
  ws: null,
  retry: 0,
  typingTimer: null,
  opOnline: false,
  opName: 'Operator',
};

const COLORS = ['#3f7ef7', '#7c4dff', '#e2574c', '#2f9e5f', '#f0a22e', '#0ea5b7', '#d946a0', '#5b6b8c'];
function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase();
}
function colorFor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return COLORS[h % COLORS.length];
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtDay(ts) {
  const d = new Date(ts), t = new Date();
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body instanceof Blob ? (opts.headers || {}) :
      { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || 'request failed');
  return data;
}

function ticksNode(msg) {
  const seen = msg.seq <= state.opReadSeq;
  const span = el('span', 'ticks' + (seen ? ' seen' : ''));
  span.innerHTML = seen
    ? '<svg viewBox="0 0 24 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m1 9 4 4 8-9"/><path d="m9 13 8-9"/></svg>'
    : '<svg viewBox="0 0 24 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 4 4 8-9"/></svg>';
  return span;
}

function attachmentCard(att) {
  const card = el('div', 'attach-card');
  const isImg = (att.mime || '').startsWith('image/');
  const ext = (att.filename.split('.').pop() || '').toUpperCase().slice(0, 4);
  const iconCls = isImg ? 'img' : att.mime === 'application/pdf' ? 'pdf' : 'doc';
  if (isImg) {
    card.classList.add('image');
    const a = el('a'); a.href = att.url; a.target = '_blank'; a.rel = 'noopener';
    const img = el('img'); img.src = att.url; img.alt = att.filename; img.loading = 'lazy';
    a.appendChild(img); card.appendChild(a);
    card.appendChild(el('div', 'finfo',
      `<div class="fname">${esc(att.filename)}</div><div class="fsize">${esc(fmtBytes(att.bytes))}</div>`));
    return card;
  }
  const a = el('a'); a.href = att.url; a.target = '_blank'; a.rel = 'noopener';
  a.innerHTML = `<div class="ficon ${iconCls}">${esc(ext || 'FILE')}</div>
    <div class="finfo"><div class="fname">${esc(att.filename)}</div>
    <div class="fsize">${esc(fmtBytes(att.bytes))}</div></div>`;
  card.appendChild(a);
  return card;
}

function render() {
  const host = $('messages');
  host.innerHTML = '';
  if (!state.messages.length) {
    const e = el('div', 'empty-list', 'This is the start of your conversation.');
    e.style.alignSelf = 'center';
    host.appendChild(e);
    return;
  }

  let lastDay = '';
  let prevType = '';
  let prevTime = 0;

  for (const m of state.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      host.appendChild(el('div', 'date-sep', esc(fmtDay(m.createdAt))));
      lastDay = day;
    }

    const mine = m.senderType === 'client';
    const grouped = m.senderType === prevType && Math.abs(m.createdAt - prevTime) < 5 * 60000;
    prevType = m.senderType;
    prevTime = m.createdAt;

    const row = el('div', 'msg-row' + (mine ? ' mine' : '') + (grouped ? ' grouped' : ' first'));
    row.appendChild(el('div', 'gutter'));

    const wrap = el('div', 'bubble-wrap');
    if (!grouped && !mine) {
      const line = el('div', 'sender-line');
      line.innerHTML = `${esc(m.senderName)} <span class="t">${esc(fmtTime(m.createdAt))}</span>`;
      wrap.appendChild(line);
    }

    const hasText = m.kind === 'text' || !m.attachment || !!m.body;
    if (hasText) {
      const bubble = el('div', 'bubble' + (m.pending ? ' pending' : ''));
      bubble.innerHTML = esc(m.body || '');
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

    if (m.attachment) {
      const card = attachmentCard(m.attachment);
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
}

async function load(since = 0) {
  const data = await api(`/api/conversations/${state.convId}/messages?since=${since}&limit=300`);
  if (since === 0) state.messages = data.messages;
  else state.messages = state.messages.concat(data.messages);
  if (typeof data.peerReadSeq === 'number') state.opReadSeq = data.peerReadSeq;
  if (data.messages.length) state.lastSeq = data.messages[data.messages.length - 1].seq;
  render();
  markRead();
}

function markRead() {
  if (!state.convId || !state.lastSeq) return;
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ t: 'read', conversationId: state.convId, seq: state.lastSeq }));
  }
  api(`/api/conversations/${state.convId}/read`, {
    method: 'POST', body: JSON.stringify({ seq: state.lastSeq }),
  }).catch(() => {});
}

let counter = 0;
function newId() { counter += 1; return 'cc' + Date.now().toString(36) + '-' + counter; }

async function send() {
  const input = $('composerInput');
  const text = input.value.trim();
  if (!text || !state.convId) return;
  input.value = '';
  autosize(input);

  const clientMsgId = newId();
  state.messages.push({
    id: 'tmp-' + clientMsgId,
    seq: (state.messages.at(-1)?.seq || 0) + 0.001,
    senderType: 'client',
    senderName: state.me.name || 'You',
    body: text, kind: 'text', createdAt: Date.now(),
    attachment: null, pending: true, clientMsgId,
  });
  render();

  try {
    const res = await api(`/api/conversations/${state.convId}/send`, {
      method: 'POST', body: JSON.stringify({ body: text, clientMsgId }),
    });
    if (res?.ok) reconcile(res.message);
  } catch {
    state.messages = state.messages.filter((m) => m.clientMsgId !== clientMsgId);
    render();
    toast('Message did not send. Check your connection.');
  }
}

function reconcile(message) {
  if (!message) return;
  const i = state.messages.findIndex((m) =>
    (m.clientMsgId && message.clientMsgId && m.clientMsgId === message.clientMsgId) || m.id === message.id);
  if (i >= 0) state.messages[i] = message; else state.messages.push(message);
  state.lastSeq = Math.max(state.lastSeq, message.seq);
  state.messages.sort((a, b) => a.seq - b.seq);
  render();
}

async function upload(file) {
  if (!file || !state.convId) return;
  const clientMsgId = newId();
  toast('Uploading ' + file.name + '…');
  try {
    const res = await fetch(`/api/conversations/${state.convId}/upload`, {
      method: 'POST', credentials: 'same-origin',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
        'X-Client-Msg-Id': clientMsgId,
      },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Upload failed'); return; }
    reconcile(data.message);
  } catch { toast('Upload failed'); }
}

function autosize(t) {
  t.style.height = 'auto';
  t.style.height = Math.min(132, t.scrollHeight) + 'px';
}

function setOperator(status) {
  $('opStatus').textContent = status;
  $('opDot').style.background = status === 'Online' ? 'var(--green)' : status === 'Offline' ? '#b9c4d0' : 'var(--amber)';
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.retry = 0;
    if (state.convId) load(state.lastSeq);
  };

  ws.onclose = () => {
    const delay = Math.min(15000, 500 * Math.pow(2, state.retry++));
    setTimeout(connectWS, delay);
  };

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.t === 'message' && msg.conversationId === state.convId) {
      reconcile(msg);
      if (msg.senderType === 'operator') markRead();
      return;
    }
    if (msg.t === 'cleared' && msg.conversationId === state.convId) {
      state.messages = [];
      state.lastSeq = 0;
      render();
      return;
    }

    if (msg.t === 'read' && msg.conversationId === state.convId && msg.by === 'operator') {
      state.opReadSeq = Math.max(state.opReadSeq, Number(msg.seq || 0));
      render();
      return;
    }
    if (msg.t === 'typing' && msg.by === 'operator') {
      $('typingWho').textContent = (msg.name || 'Operator') + ' is typing…';
      $('typing').classList.add('on');
      clearTimeout(connectWS._t);
      connectWS._t = setTimeout(() => $('typing').classList.remove('on'), 3000);
      return;
    }
    if (msg.t === 'operator_status') {
      state.opOnline = msg.status === 'Online';
      setOperator(msg.status || 'Offline');
      return;
    }
  };
}

function wire() {
  $('btnSend').addEventListener('click', send);
  const input = $('composerInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    autosize(input);
    if (!state.convId) return;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      api(`/api/conversations/${state.convId}/typing`, { method: 'POST' }).catch(() => {});
    }, 350);
  });

  $('btnAttach').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) upload(f);
    e.target.value = '';
  });

  $('messages').addEventListener('dragover', (e) => e.preventDefault());
  $('messages').addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) upload(f);
  });

  $('btnRefresh').addEventListener('click', () => { if (state.convId) load(0); });

  $('btnTranscript').addEventListener('click', async () => {
    if (!state.convId) return;
    try {
      const res = await api(`/api/conversations/${state.convId}/transcript`, { method: 'POST' });
      if (res.emailed) toast('Transcript sent to your email');
      else {
        const blob = new Blob([res.transcript || ''], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'conversation.txt';
        a.click();
        toast('Transcript downloaded');
      }
    } catch { toast('Could not create the transcript'); }
  });

  $('btnNameSave').addEventListener('click', async () => {
    const name = $('clientName').value.trim();
    if (!name) { toast('Please enter your name'); return; }
    const res = await api('/api/client/identify', {
      method: 'POST',
      body: JSON.stringify({ name, email: $('clientEmail').value.trim() }),
    });
    state.me.name = name;
    state.convId = res.conversationId;
    $('namecard').style.display = 'none';
    await load(0);
    connectWS();
    $('composerInput').focus();
  });

  $('clientName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnNameSave').click(); });
}

async function boot() {
  wire();
  const data = await api('/api/bootstrap');

  state.me = data.me;
  state.convId = data.me.conversationId;
  state.opName = 'Operator';

  $('opName').textContent = state.opName;
  $('opAvatar').textContent = initials(state.opName);
  $('opAvatar').style.background = colorFor(state.opName);
  setOperator(data.operatorOnline ? 'Online' : 'Offline');

  if (!data.me.name) {
    $('namecard').style.display = 'grid';
    $('clientName').focus();
    $('messages').innerHTML = '';
    return;
  }

  if (data.me.email) {
    $('footNote').innerHTML =
      `Replies are emailed to ${esc(data.me.email)} when you are away. ` +
      `<a href="#" id="stopLink">Stop notifications</a>`;
    $('stopLink').addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/api/client/notifications/stop', { method: 'POST' });
      $('footNote').textContent = 'Email notifications are off for this conversation.';
      toast('Notifications stopped');
    });
  } else {
    $('footNote').textContent = '';
  }

  if (state.convId) { await load(0); connectWS(); }
  $('composerInput').focus();
}

boot().catch((err) => {
  console.error(err);
  const card = $('namecard');
  if (card) card.style.display = 'grid';
});
