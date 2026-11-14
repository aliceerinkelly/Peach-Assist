/* Public room: join with a name, then read and post. Polls for new messages. */
(function () {
  var convId = (location.pathname.match(/^\/r\/([^/]+)/) || [])[1];
  var KEY = 'room-name';
  var state = { me: null, lastSeq: 0, timer: null, joined: false };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function timeOf(ms) {
    try {
      return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function showErr(text) { $('err').textContent = text || ''; }

  function render(list, append) {
    var host = $('messages');
    if (!append) host.innerHTML = '';
    list.forEach(function (m) {
      var mine = m.senderName === state.me;
      var wrap = document.createElement('div');
      wrap.className = 'rmsg' + (mine ? ' mine' : '');
      wrap.innerHTML =
        (mine ? '' : '<div class="who">' + esc(m.senderName) + '</div>') +
        '<div class="b">' + esc(m.body) + '</div>' +
        '<div class="ts">' + esc(timeOf(m.createdAt)) + '</div>';
      host.appendChild(wrap);
    });
    host.scrollTop = host.scrollHeight;
  }

  async function load(since) {
    var res = await fetch('/api/rooms/' + convId + '/messages?since=' + (since || 0), {
      credentials: 'same-origin',
    });
    if (res.status === 401) { showJoin(); return; }
    var data = await res.json();
    if (data.title) $('roomTitle').textContent = data.title;
    if (data.me) {
      state.me = data.me;
      $('roomSub').textContent = 'You are in as ' + data.me;
    }
    var list = data.messages || [];
    if (list.length) {
      state.lastSeq = list[list.length - 1].seq;
      render(list, since > 0);
    }
  }

  function showJoin() {
    state.joined = false;
    $('joinWrap').style.display = 'grid';
    $('messages').style.display = 'none';
    $('composer').style.display = 'none';
  }

  function showRoom() {
    state.joined = true;
    $('joinWrap').style.display = 'none';
    $('messages').style.display = 'flex';
    $('composer').style.display = 'flex';
    $('input').focus();
  }

  async function join() {
    var name = $('name').value.trim();
    if (name.length < 2) { showErr('Enter your name first.'); return; }
    showErr('');
    var res = await fetch('/api/rooms/' + convId + '/join', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { showErr(data.error || 'Could not join.'); return; }
    state.me = data.name;
    try { localStorage.setItem(KEY, data.name); } catch (e) {}
    $('roomTitle').textContent = data.title || 'Room';
    $('roomSub').textContent = 'You are in as ' + data.name;
    showRoom();
    await load(0);
    startPolling();
  }

  async function send() {
    var input = $('input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    try {
      var res = await fetch('/api/rooms/' + convId + '/send', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) throw new Error('failed');
      await load(state.lastSeq);
    } catch (e) {
      input.value = text;
      showErr('Message did not send. Try again.');
    }
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (state.joined) load(state.lastSeq).catch(function () {});
    }, 2000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.joined) load(state.lastSeq).catch(function () {});
    });
  }

  $('btnJoin').addEventListener('click', join);
  $('name').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
  $('btnSend').addEventListener('click', send);
  $('input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  try {
    var saved = localStorage.getItem(KEY);
    if (saved) $('name').value = saved;
  } catch (e) {}
  $('name').focus();

  // Already joined in this browser? Go straight in.
  load(0).then(function () {
    if (!state.joined && state.me) { showRoom(); startPolling(); }
  }).catch(function () {});
})();
