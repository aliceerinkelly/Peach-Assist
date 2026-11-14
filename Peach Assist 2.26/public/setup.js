/* First-run setup: audience, purpose, then the parts to run. */
(function () {
  var state = { data: null, audience: 'personal', preset: null, on: {}, reach: 'lan', ack: false, needAccount: false };

  function $(id) { return document.getElementById(id); }

  function show(step) {
    for (var i = 0; i <= 4; i++) $('step' + i).hidden = i !== step;
  }

  function say(text, ok) {
    var el = $('setupMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (ok ? ' ok' : '');
  }

  function renderPresets() {
    var host = $('presetList');
    host.innerHTML = '';
    var list = (state.data.presets || []).filter(function (p) { return p.audience === state.audience; });
    list.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'choice' + (state.preset === p.id ? ' sel' : '');
      b.innerHTML = '<strong></strong><span></span>';
      b.querySelector('strong').textContent = p.label;
      b.querySelector('span').textContent = p.hint;
      b.addEventListener('click', function () {
        state.preset = p.id;
        applyPreset(p);
        renderPresets();
        renderModules();
        say('');
        show(3);
      });
      host.appendChild(b);
    });
  }

  // A preset is a starting point, not a lock: the boxes below stay editable.
  function applyPreset(preset) {
    var off = preset.off || [];
    (state.data.modules || []).forEach(function (m) {
      state.on[m.id] = off.indexOf(m.id) < 0;
    });
  }

  function renderModules() {
    var host = $('modList');
    host.innerHTML = '';
    (state.data.modules || []).forEach(function (m) {
      var labels = (m.labels && m.labels[state.audience]) || {};
      var row = document.createElement('label');
      row.className = 'mod';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.on[m.id] !== false;
      box.addEventListener('change', function () { state.on[m.id] = box.checked; });
      var text = document.createElement('span');
      var b = document.createElement('b');
      b.textContent = labels.label || m.id;
      var i = document.createElement('i');
      i.textContent = labels.hint || '';
      text.appendChild(b);
      text.appendChild(i);
      row.appendChild(box);
      row.appendChild(text);
      host.appendChild(row);
    });
  }

  // The five lights, in the order the manual lists them. The server names the
  // cause; this only draws it.
  function runChecks() {
    var host = $('netList');
    $('netMsg').textContent = 'Checking...';
    fetch('/api/network/check').then(function (r) { return r.json(); }).then(function (data) {
      host.innerHTML = '';
      (data.checks || []).forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'lit ' + (c.state || 'warn');
        var dot = document.createElement('span'); dot.className = 'dot';
        var b = document.createElement('b'); b.textContent = c.label;
        var why = document.createElement('span'); why.className = 'why'; why.textContent = c.detail;
        row.appendChild(dot);
        row.appendChild(b);
        row.appendChild(why);
        host.appendChild(row);
      });
      // Their own network, in their own words. No lesson, just the facts that
      // decide whether an install is possible at all.
      var net = data.network || {};
      var facts = $('netFacts');
      if (facts) {
        if (net.outsideIp) {
          var bits = [];
          bits.push('This computer is ' + (net.lan || 'unknown') + '.');
          bits.push(net.gateway ? 'The router is ' + net.gateway + '.' : 'No router address was found.');
          bits.push('The internet sees ' + net.outsideIp + '.');
          if (net.cgnat) {
            bits.push('The router is itself behind another router (carrier-grade NAT), so nothing outside can reach you and forwarding cannot work on this connection.');
          } else if (net.routerWan) {
            bits.push('The router reports ' + net.routerWan + '.');
          }
          bits.push(net.upnp === 'yes' ? 'The router answers UPnP.' : 'The router does not answer UPnP.');
          facts.textContent = bits.join(' ');
          facts.className = 'lead' + (net.cgnat ? ' bad' : '');
        } else if (data.checks) {
          facts.textContent = 'Could not read this network just now.';
        }
      }
      $('netMsg').textContent = data.checks ? '' : 'No answer from the server.';
    }).catch(function (err) {
      $('netMsg').textContent = 'Could not check: ' + (err.message || err);
    });
  }

  function chooseReach(which) {
    state.reach = which;
    var buttons = document.querySelectorAll('[data-reach]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('sel', buttons[i].getAttribute('data-reach') === which);
    }
    $('netPanel').hidden = which === 'lan';
    $('ackRow').hidden = which !== 'manual';
    $('ackBox').checked = state.ack;
    $('netMsg').textContent = '';
    if (which === 'noip') runChecks();
  }

  function finish() {
    var chosen = Object.keys(state.on).filter(function (id) { return state.on[id] !== false; });
    var body = { audience: state.audience, preset: state.preset || '', modules: chosen, reach: state.reach, ack: state.ack === true };
    say('Saving…', true);
    fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, data: data }; });
    }).then(function (res) {
      if (!res.ok) {
        say(res.data && res.data.error
          ? 'Not saved: ' + res.data.error
          : 'Not saved — an administrator must be signed in to change this.', false);
        return;
      }
      if (state.needAccount) { say('Saved.', true); show(4); return; }
      say('Saved. Opening the sign-in page…', true);
      setTimeout(function () { location.href = '/login'; }, 700);
    }).catch(function (err) {
      say('Could not save: ' + (err.message || err), false);
    });
  }

  function wire() {
    var choices = document.querySelectorAll('[data-audience]');
    for (var i = 0; i < choices.length; i++) {
      choices[i].addEventListener('click', function (e) {
        state.audience = e.currentTarget.getAttribute('data-audience');
        state.preset = null;
        for (var j = 0; j < choices.length; j++) choices[j].classList.toggle('sel', choices[j] === e.currentTarget);
        renderPresets();
        say('');
        show(2);
      });
    }
    var reachBtns = document.querySelectorAll('[data-reach]');
    for (var r = 0; r < reachBtns.length; r++) {
      reachBtns[r].addEventListener('click', function (e) {
        chooseReach(e.currentTarget.getAttribute('data-reach'));
      });
    }
    $('ackBox').addEventListener('change', function () { state.ack = $('ackBox').checked; });
    $('btnNetCheck').addEventListener('click', runChecks);
    $('btnNetContinue').addEventListener('click', function () {
      if (state.reach === 'manual' && !state.ack) {
        $('netMsg').textContent = 'Tick the box to continue, or use the guided setup instead.';
        return;
      }
      show(1);
    });
    $('btnBack1').addEventListener('click', function () { show(1); });
    $('btnBack2').addEventListener('click', function () { show(2); });
    $('btnSkipPreset').addEventListener('click', function () {
      state.preset = null;
      renderModules();
      say('');
      show(3);
    });
    $('btnFinish').addEventListener('click', finish);
    $('btnAccount').addEventListener('click', function () {
      var name = ($('accName').value || '').trim();
      var user = ($('accUser').value || '').trim();
      var pass = $('accPass').value || '';
      var again = $('accPass2').value || '';
      var msg = $('accMsg');
      if (!name) { msg.className = 'msg'; msg.textContent = 'Your name is required.'; return; }
      if (pass.length < 8) { msg.className = 'msg'; msg.textContent = 'The password needs at least eight characters.'; return; }
      if (pass !== again) { msg.className = 'msg'; msg.textContent = 'The two passwords do not match.'; return; }
      msg.className = 'msg ok';
      msg.textContent = 'Saving…';
      fetch('/api/setup/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, username: user, password: pass }),
      }).then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      }).then(function (res) {
        if (!res.ok) {
          msg.className = 'msg';
          msg.textContent = 'Not saved: ' + ((res.d && res.d.error) || 'the server refused it');
          return;
        }
        msg.textContent = 'Saved. Taking you to the sign-in page…';
        setTimeout(function () { location.href = '/login'; }, 800);
      }).catch(function (err) {
        msg.className = 'msg';
        msg.textContent = 'Could not save: ' + (err.message || err);
      });
    });
  }

  fetch('/api/setup').then(function (r) { return r.json(); }).then(function (data) {
    state.data = data;
    if (data.done) $('doneNote').hidden = false;
    (data.modules || []).forEach(function (m) { state.on[m.id] = !!m.on; });
    if (data.audience) {
      state.audience = data.audience;
      var sel = document.querySelector('[data-audience="' + data.audience + '"]');
      if (sel) sel.classList.add('sel');
    }
    state.needAccount = !!data.needAccount;
    if (data.reach) {
      state.reach = data.reach;
      state.ack = !!data.reachAck;
    }
    renderPresets();
    renderModules();
    wire();
    if (data.reach) chooseReach(data.reach);
    show(0);
  }).catch(function (err) {
    say('Could not reach the server: ' + (err.message || err), false);
  });
})();
