/*
 * UI controller — renders an engine view and turns clicks into engine actions.
 * No rules here. Two modes:
 *   local  — pass-and-play on one device: actions run through TC.Game.applyAction in this page.
 *   online — the server owns the state: actions are POSTed, views arrive over Server-Sent Events,
 *            and this client may only act for its own Traveler (the server enforces it).
 */
(function (root) {
  'use strict';
  var TC = root.TC;
  var R = TC.Rules;
  var G = TC.Game;
  var B = TC.UI.Board;
  var W = TC.UI.Wheels;
  var esc = W.esc;
  var SYM = W.SYMBOLS;

  var STORAGE_KEY = 'timeline-challenge.v1';
  var STEP_MS = 210;

  var NET = TC.UI.Online;

  // mode: 'home' | 'local' | 'online'. `state` exists only in local mode; online clients never hold it.
  var store = { mode: 'home', state: null, view: null, net: 'offline' };
  var ui = {
    board: null,
    display: {},
    animTimer: null,
    modal: null,
    lobbyToken: null,
    seenRevealed: {},
    celebrated: null,
    drafts: {}
  };
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ state plumbing

  function load() {
    try {
      var saved = G.restore(localStorage.getItem(STORAGE_KEY));
      if (saved) return saved;
    } catch (e) { /* storage unavailable: play without persistence */ }
    return G.createLobby();
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store.state)); } catch (e) { /* ignore */ }
  }

  function dispatch(action) {
    if (store.mode === 'online') {
      // The server validates and broadcasts; the new view arrives over the stream.
      action.seq = store.view ? store.view.seq : undefined;
      NET.send(action).then(function (r) { if (!r.ok) toast(r.error, 'error'); });
      return true;
    }
    action.seq = store.state.seq;
    var r = G.applyAction(store.state, action);
    if (!r.ok) { toast(r.error, 'error'); render(); return false; }
    store.state = r.state;
    save();
    render();
    return true;
  }

  function replaceState(s) {
    store.state = s;
    resetUI();
    save();
    render();
  }

  function resetUI() {
    ui.display = {};
    ui.seenRevealed = {};
    ui.modal = null;
  }

  function rematch() {
    if (store.mode === 'online') dispatch({ type: 'ROOM_REMATCH' });
    else replaceState(G.rematch(store.state));
  }

  function fresh() {
    if (store.mode === 'online') leaveRoom();
    else replaceState(G.createLobby());
  }

  // ------------------------------------------------------------ modes

  function startLocal() {
    store.mode = 'local';
    store.state = load();
    resetUI();
    render();
  }

  function goHome() {
    if (store.mode === 'online') NET.leave();
    store.mode = 'home';
    store.view = null;
    resetUI();
    history.replaceState(null, '', location.pathname);
    render();
  }

  function goOnline(code, token) {
    store.mode = 'online';
    store.view = null;
    resetUI();
    history.replaceState(null, '', location.pathname + '?room=' + encodeURIComponent(code));
    NET.connect(code, token,
      function (view) { store.view = view; render(); },
      function (status) { store.net = status; renderNet(); });
    render();
  }

  /**
   * In the lobby (or as a spectator) leaving frees your place and Traveler for someone else.
   * A Traveler in a running game cannot leave the race, so mid-game this only disconnects —
   * "กลับเข้าห้อง" on the home screen brings you back to the same Traveler.
   */
  function leaveRoom() {
    var v = store.view;
    if (isOnline() && v && (v.phase === 'LOBBY' || !myId())) {
      NET.send({ type: 'ROOM_LEAVE' }).then(function () { NET.forgetLast(); goHome(); });
    } else {
      goHome();
    }
  }

  function joinOrReconnect(promise) {
    return promise.then(function (r) {
      if (r.ok) goOnline(r.code, r.token);
      else toast(r.error, 'error');
      return r;
    });
  }

  // Permissions only decide which buttons to show; the server enforces them again.
  function isOnline() { return store.mode === 'online'; }
  function myId() { return isOnline() && store.view && store.view.room ? store.view.room.me : null; }
  function canActFor(pid) { return !isOnline() || myId() === pid; }
  function isSeated() { return !isOnline() || !!myId(); }
  function amHost() { return !isOnline() || !!(store.view && store.view.room && store.view.room.isHost); }

  /**
   * Answers being set but not yet locked live only here, keyed by room + Trial + player.
   * Server updates never touch them, so a player's selection survives everyone else's actions,
   * and closing / reopening the sheet resumes it.
   */
  function draftKey(v, pid) {
    return (v.room ? v.room.code : 'local') + ':' + v.trial.no + ':' + pid;
  }

  function pruneDrafts(v) {
    var prefix = v.trial ? draftKey(v, '') : null;
    Object.keys(ui.drafts).forEach(function (k) {
      if (!prefix || k.indexOf(prefix) !== 0) delete ui.drafts[k];
    });
  }

  /** Re-render a container without losing what the user is typing in its inputs. */
  function keepInputs(container, renderFn) {
    var saved = {};
    Array.prototype.forEach.call(container.querySelectorAll('input[id]:not([readonly])'), function (i) {
      saved[i.id] = { value: i.value, start: i.selectionStart, end: i.selectionEnd };
    });
    var active = document.activeElement;
    var focusId = active && active.id && container.contains(active) ? active.id : null;
    renderFn();
    Object.keys(saved).forEach(function (id) {
      var el = document.getElementById(id);
      if (el && container.contains(el)) el.value = saved[id].value;
    });
    var f = focusId && document.getElementById(focusId);
    if (f && container.contains(f)) {
      f.focus();
      try { f.setSelectionRange(saved[focusId].start, saved[focusId].end); } catch (e) { /* number inputs */ }
    }
  }

  function membersOf(v, pid) {
    if (!v.room) return [];
    return v.room.members.filter(function (m) { return m.playerId === pid; });
  }

  // ------------------------------------------------------------ helpers

  function player(v, id) {
    for (var i = 0; i < v.players.length; i++) if (v.players[i].id === id) return v.players[i];
    return null;
  }

  function who(v, id, withIcon) {
    var p = player(v, id);
    if (!p) return '';
    var tok = B.tokenOf(p.token);
    return '<span class="who" style="--pc:' + tok.color + '">' + (withIcon === false ? '' : '<i>' + tok.icon + '</i>') + esc(p.name) + '</span>';
  }

  function trialBadge(type) {
    var t = R.TRIALS[type];
    return '<span class="tbadge" style="--tc:' + B.COLORS[t.color] + '">' + esc(t.name) + '</span>';
  }

  function cardHTML(c, opts) {
    opts = opts || {};
    var cat = TC.CATEGORIES[c.category];
    var flip = c.revealed && !ui.seenRevealed[c.id];
    if (c.revealed) ui.seenRevealed[c.id] = true;
    return '<div class="card' + (c.revealed ? ' is-revealed' : '') + (flip ? ' do-flip' : '') +
      (opts.small ? ' card-sm' : '') + (opts.extraClass ? ' ' + opts.extraClass : '') + '" style="--cat:' + cat.color + '">' +
      (opts.symbol ? '<span class="card-sym">' + opts.symbol + '</span>' : '') +
      '<div class="card-img" aria-hidden="true">' + esc(c.image) + '</div>' +
      '<div class="card-title">' + esc(c.title) + '</div>' +
      '<div class="card-en">' + esc(c.en) + '</div>' +
      '<div class="card-cat">' + esc(cat.label) + '</div>' +
      '<div class="card-year"><span>' + (c.revealed ? esc(R.formatYear(c.year)) : '????') + '</span>' +
      (c.revealed && c.approx ? '<small>โดยประมาณ</small>' : '') + '</div>' +
      (opts.note ? '<div class="card-note">' + opts.note + '</div>' : '') +
      '</div>';
  }

  function toast(text, kind) {
    var t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 2600);
    setTimeout(function () { t.remove(); }, 3100);
  }

  // ------------------------------------------------------------ render root

  function render() {
    if (store.mode === 'home') {
      document.body.dataset.phase = 'HOME';
      $('screen-home').hidden = false;
      $('screen-lobby').hidden = true;
      $('screen-game').hidden = true;
      renderHome();
      renderModal(null);
      return;
    }
    $('screen-home').hidden = true;
    if (store.mode === 'local') store.view = G.getView(store.state);
    var v = store.view;
    if (!v) {   // online, waiting for the first snapshot
      $('screen-lobby').hidden = false;
      $('screen-game').hidden = true;
      $('screen-lobby').innerHTML = '<div class="lobby"><p class="empty">กำลังเชื่อมต่อห้อง…</p></div>';
      return;
    }
    document.body.dataset.phase = v.phase;
    pruneDrafts(v);
    var lobby = v.phase === G.PHASE.LOBBY;
    $('screen-lobby').hidden = !lobby;
    $('screen-game').hidden = lobby;
    if (lobby) {
      if (isOnline()) renderOnlineLobby(v); else renderLobby(v);
    } else {
      if (!ui.board) ui.board = B.create($('board'));
      renderHeader(v);
      renderTimeline(v);
      renderPanel(v);
      renderPlayers(v);
      renderLog(v);
      animatePawns(v);
    }
    renderModal(v);
  }

  // ------------------------------------------------------------ home

  function renderHome() {
    var params = new URLSearchParams(location.search);
    var code = (params.get('room') || '').toUpperCase();
    var last = NET.last();
    var name = (last && last.name) || '';
    var hasLocal = false;
    try { hasLocal = !!localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }

    var online = NET.available()
      ? '<form class="box" id="home-form" autocomplete="off"><h3>🌐 เล่นออนไลน์กับเพื่อน</h3>' +
        '<label class="field"><span>ชื่อของคุณ</span><input id="h-name" maxlength="' + R.MAX_NAME_LENGTH + '" value="' + esc(name) + '" placeholder="เช่น มะลิ"></label>' +
        '<button class="btn primary wide big" type="button" id="h-create">สร้างห้องใหม่</button>' +
        '<div class="or"><span>หรือเข้าห้องของเพื่อน</span></div>' +
        '<div class="join-row"><input id="h-code" maxlength="8" placeholder="รหัสห้อง" value="' + esc(code) + '" autocapitalize="characters">' +
        '<button class="btn primary" type="submit">เข้าห้อง</button></div>' +
        (last && last.code ? '<button class="btn ghost wide" type="button" id="h-back">↩ กลับเข้าห้อง ' + esc(last.code) + ' ในชื่อ ' + esc(last.name) + '</button>' : '') +
        '</form>'
      : '<div class="box"><h3>🌐 เล่นออนไลน์</h3><p class="muted">เปิดเกมผ่านเซิร์ฟเวอร์ (เช่น <code>python server/server.py</code>) เพื่อเล่นออนไลน์ — ไฟล์ที่เปิดตรงจากเครื่องเล่นได้เฉพาะแบบเครื่องเดียว</p></div>';

    $('screen-home').innerHTML = '<div class="lobby">' +
      '<div class="hero"><div class="hero-clock" aria-hidden="true">⏳</div><h1>Timeline Challenge</h1>' +
      '<p>แข่งเดินทางข้ามกาลเวลาบนหน้าปัดนาฬิกา — ผู้นำเป็นคนกำหนด Trial, คนที่ตามหลังได้ลุ้น Challenge, ใครถึง Finish ก่อนชนะ</p></div>' +
      '<div class="lobby-grid">' + online +
      '<div class="box"><h3>📱 เล่นบนเครื่องเดียว</h3><p class="muted small">ผลัดกันตอบบนอุปกรณ์เครื่องเดียว (pass-and-play)</p>' +
      '<button class="btn wide big" id="h-local">' + (hasLocal ? 'เล่นต่อ / เปิดเกมบนเครื่องนี้' : 'เริ่มเล่นบนเครื่องนี้') + '</button></div>' +
      '</div><p class="lobby-foot"><button class="btn link" data-open="rules">อ่านกติกาฉบับย่อ</button></p></div>';
    var focus = code ? $('h-name') : null;
    if (focus && !focus.value) focus.focus();
  }

  function onHomeClick(e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'h-local') return startLocal();
    if (b.id === 'h-create') {
      b.disabled = true;
      NET.createRoom($('h-name').value).then(function (r) {
        b.disabled = false;
        if (r.ok) goOnline(r.code, r.token); else toast(r.error, 'error');
      });
      return;
    }
    if (b.id === 'h-back') {
      var last = NET.last();
      joinOrReconnect(NET.joinRoom(last.code, last.name, last.token)).then(function (r) {
        if (!r.ok) { NET.forgetLast(); render(); }
      });
    }
  }

  function onHomeSubmit(e) {
    e.preventDefault();
    var code = $('h-code').value.trim().toUpperCase();
    if (!code) { toast('กรุณาใส่รหัสห้อง', 'error'); return; }
    joinOrReconnect(NET.joinRoom(code, $('h-name').value));
  }

  // ------------------------------------------------------------ online room bar / lobby

  function renderNet() {
    var el = document.querySelectorAll('[data-net]');
    var label = { online: '● ออนไลน์', connecting: '… กำลังเชื่อมต่อ', reconnecting: '… กำลังเชื่อมต่อใหม่', offline: '○ หลุดการเชื่อมต่อ' }[store.net] || '';
    Array.prototype.forEach.call(el, function (n) { n.textContent = label; n.dataset.net = store.net; });
  }

  function roomBar(v) {
    var link = NET.shareLink(v.room.code);
    return '<div class="roombar"><div><span class="muted small">รหัสห้อง</span><b class="room-code">' + esc(v.room.code) + '</b></div>' +
      '<input class="share-link" readonly value="' + esc(link) + '" aria-label="ลิงก์เชิญ">' +
      '<button class="btn primary sm" data-copy="' + esc(link) + '">คัดลอกลิงก์เชิญ</button>' +
      '<span class="net" data-net="' + store.net + '"></span>' +
      '<button class="btn ghost sm" data-act="leave">ออกจากห้อง</button></div>';
  }

  function renderOnlineLobby(v) {
    var room = v.room, me = room.me;
    var taken = v.players.map(function (p) { return p.token; });
    if (!ui.lobbyToken || taken.indexOf(ui.lobbyToken) !== -1) {
      var free = R.TOKENS.filter(function (t) { return taken.indexOf(t.id) === -1; })[0];
      ui.lobbyToken = free ? free.id : null;
    }
    var full = v.players.length >= R.MAX_PLAYERS;
    var allReady = v.players.length >= R.MIN_PLAYERS && v.players.every(function (p) { return p.ready; });
    var mine = me ? player(v, me) : null;
    var ownerOf = {};
    v.players.forEach(function (p) { ownerOf[p.token] = p.name; });

    var left;
    if (mine) {
      var mt = B.tokenOf(mine.token);
      left = '<div class="box"><h3>Traveler ของคุณ</h3><div class="me-card" style="--pc:' + mt.color + '"><span class="ptoken">' + mt.icon + '</span>' +
        '<div class="grow"><b>' + esc(mine.name) + '</b><small>' + esc(mt.name) + '</small></div></div>' +
        '<button class="btn ' + (mine.ready ? 'ok' : 'primary') + ' wide big" data-ready="' + me + '">' + (mine.ready ? '✓ พร้อมแล้ว (กดเพื่อยกเลิก)' : 'กดพร้อม') + '</button>' +
        '<button class="btn ghost wide" data-act="leave-seat">คืน Traveler (เลือกตัวใหม่)</button></div>';
    } else {
      left = '<form class="box" id="add-form" autocomplete="off"><h3>เลือก Traveler ของคุณ</h3>' +
        '<label class="field"><span>ชื่อที่แสดงในเกม</span><input id="f-name" maxlength="' + R.MAX_NAME_LENGTH + '" value="' + esc(room.myName || '') + '" ' + (full ? 'disabled' : '') + '></label>' +
        '<div class="field"><span>Traveler (ว่าง ' + (R.TOKENS.length - taken.length) + ' / ' + R.TOKENS.length + ')</span><div class="token-pick">' +
        R.TOKENS.map(function (t) {
          var used = taken.indexOf(t.id) !== -1;
          return '<button type="button" class="tok' + (ui.lobbyToken === t.id ? ' is-on' : '') + (used ? ' is-taken' : '') + '" data-token="' + t.id + '" ' +
            (used ? 'disabled' : '') + ' style="--pc:' + t.color + '" title="' + esc(t.name) + (used ? ' — ' + esc(ownerOf[t.id]) + ' เลือกแล้ว' : '') + '">' +
            '<span>' + t.icon + '</span><small>' + (used ? 'ไม่ว่าง · ' + esc(ownerOf[t.id]) : esc(t.name)) + '</small></button>';
        }).join('') + '</div></div>' +
        '<button class="btn primary wide" type="submit" ' + (full || !ui.lobbyToken ? 'disabled' : '') + '>' + (full ? 'Traveler เต็มแล้ว' : 'ยืนยัน Traveler นี้') + '</button></form>';
    }

    var roster = v.players.length ? '<ul class="roster">' + v.players.map(function (p) {
      var t = B.tokenOf(p.token);
      var ms = membersOf(v, p.id);
      return '<li style="--pc:' + t.color + '"><span class="ptoken">' + t.icon + '</span>' +
        '<div class="grow"><b>' + esc(p.name) + (p.id === me ? ' <span class="b lead">คุณ</span>' : '') + '</b>' +
        '<small>' + esc(t.name) + (ms.length ? ' · ' + ms.map(memberLabel).join(', ') : '') + '</small></div>' +
        (p.ready ? '<span class="b ok">✓ พร้อม</span>' : '<span class="b wait">ยังไม่พร้อม</span>') +
        (room.isHost && p.id !== me ? '<button class="btn ghost sm icon" data-remove="' + p.id + '" aria-label="ลบ ' + esc(p.name) + '">✕</button>' : '') +
        '</li>';
    }).join('') + '</ul>' : '<p class="empty">ยังไม่มีผู้เล่นเลือก Traveler — ต้องมีอย่างน้อย 2</p>';
    var watchers = room.members.filter(function (m) { return !m.playerId; });

    var lobbyHTML = '<div class="lobby">' + roomBar(v) + modeBox(v) +
      '<div class="lobby-grid">' + left +
      '<div class="box"><h3>ผู้เล่น <span class="player-count">' + v.players.length + ' / ' + R.MAX_PLAYERS + '</span>' +
      '<span class="muted small"> · อยู่ในห้อง ' + room.members.length + ' / ' + room.capacity + ' คน</span></h3>' + roster +
      (watchers.length ? '<p class="muted small">ยังไม่ได้เลือก Traveler: ' + watchers.map(memberLabel).join(', ') + '</p>' : '') +
      (room.isHost
        ? '<button class="btn primary wide big" id="start-game" ' + (allReady ? '' : 'disabled') + '>เริ่มเกม ▶</button>'
        : '<p class="muted center">รอหัวห้องกดเริ่มเกม</p>') +
      '<p class="muted small">' + (v.players.length < R.MIN_PLAYERS ? 'ต้องมีอย่างน้อย 2 Traveler' :
        allReady ? 'ทุกคนพร้อมแล้ว! Trial แรกคือ Timeline 4' : 'รอทุก Traveler กด "พร้อม"') + '</p>' +
      '</div></div>' +
      '<p class="lobby-foot"><button class="btn link" data-open="rules">อ่านกติกาฉบับย่อ</button></p></div>';
    keepInputs($('screen-lobby'), function () { $('screen-lobby').innerHTML = lobbyHTML; });
    renderNet();
  }

  var TARGET_LABEL = { 11: 'Short', 15: 'Medium', 21: 'Long' };

  /** Classic / Speed Run picker. Online, only the host may change it; everyone sees the same value. */
  function modeBox(v) {
    var m = v.mode, speed = m.type === 'SPEED_RUN', can = amHost();
    function opt(attrs, label, on) {
      return '<button type="button" class="mode-opt' + (on ? ' is-on' : '') + '" ' + attrs + (can ? '' : ' disabled') + '>' + label + '</button>';
    }
    return '<div class="box mode-box"><h3>โหมดเกม</h3><div class="mode-row">' +
      opt('data-mode="CLASSIC"', '<b>Classic</b><small>ถึงช่อง Finish ก่อนชนะ (กติกาเดิม)</small>', !speed) +
      opt('data-mode="SPEED_RUN"', '<b>Speed Run ⚡</b><small>ได้แต้มถึงเป้าก่อนชนะ</small>', speed) + '</div>' +
      (speed ? '<div class="mode-row targets">' + R.SPEED_RUN_TARGETS.map(function (t) {
        return opt('data-target="' + t + '"', '<b>' + t + ' แต้ม</b><small>' + TARGET_LABEL[t] +
          (t === R.SPEED_RUN_DEFAULT ? ' · แนะนำ' : '') + (t === R.FINISH ? ' · ระยะเท่า Finish' : '') + '</small>', m.target === t);
      }).join('') + '</div>' : '') +
      '<p class="muted small">' + (speed
        ? 'แต้ม = จำนวนช่องที่เดินบน Clock · Trial, Challenge, การเดิน และคะแนนเหมือนเดิมทุกอย่าง เปลี่ยนแค่เงื่อนไขชนะ'
        : 'กติกาตาม rulebook ทั้งหมด') +
      (can ? '' : ' · หัวห้องเป็นคนเลือก') + ' · เปลี่ยนไม่ได้หลังเริ่มเกม</p></div>';
  }

  function modeChip(v) {
    return v.mode.type === 'SPEED_RUN'
      ? '<span class="chip warn">⚡ Speed Run ' + v.mode.target + ' แต้ม</span>'
      : '<span class="chip">Classic</span>';
  }

  function scoreText(v, p) {
    if (v.mode.type === 'SPEED_RUN') return p.position + ' <span class="muted">/ ' + v.goal + ' แต้ม</span>';
    return (p.position >= R.FINISH ? 'Finish!' : p.position === 0 ? 'Start' : 'ช่อง ' + p.position) + ' <span class="muted">/ ' + R.FINISH + '</span>';
  }

  function memberLabel(m) {
    return '<span class="member' + (m.online ? '' : ' off') + '">' + (m.host ? '👑' : '') + esc(m.name) + (m.me ? ' (คุณ)' : '') + '</span>';
  }

  function copyText(text) {
    var done = function () { toast('คัดลอกลิงก์แล้ว — ส่งให้เพื่อนได้เลย', 'ok'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast(text); }
    ta.remove();
  }

  // ------------------------------------------------------------ lobby (local)

  function renderLobby(v) {
    var taken = v.players.map(function (p) { return p.token; });
    if (!ui.lobbyToken || taken.indexOf(ui.lobbyToken) !== -1) {
      var free = R.TOKENS.filter(function (t) { return taken.indexOf(t.id) === -1; })[0];
      ui.lobbyToken = free ? free.id : null;
    }
    var full = v.players.length >= R.MAX_PLAYERS;
    var allReady = v.players.length >= R.MIN_PLAYERS && v.players.every(function (p) { return p.ready; });

    var html = '<div class="lobby">' +
      '<div class="hero"><div class="hero-clock" aria-hidden="true">⏳</div>' +
      '<h1>Timeline Challenge</h1>' +
      '<p>แข่งเดินทางข้ามกาลเวลาบนหน้าปัดนาฬิกา — ผู้นำเป็นคนกำหนด Trial, คนที่ตามหลังได้ลุ้น Challenge, ใครถึง Finish ก่อนชนะ</p></div>' +
      modeBox(v) +
      '<div class="lobby-grid">' +
      '<form class="box" id="add-form" autocomplete="off"><h3>เพิ่ม Traveler</h3>' +
      '<label class="field"><span>ชื่อผู้เล่น / ทีม</span><input id="f-name" maxlength="' + R.MAX_NAME_LENGTH + '" placeholder="เช่น มะลิ" ' + (full ? 'disabled' : '') + '></label>' +
      '<div class="field"><span>เลือก Traveler token</span><div class="token-pick">' +
      R.TOKENS.map(function (t) {
        var used = taken.indexOf(t.id) !== -1;
        return '<button type="button" class="tok' + (ui.lobbyToken === t.id ? ' is-on' : '') + '" data-token="' + t.id + '" ' +
          (used ? 'disabled' : '') + ' style="--pc:' + t.color + '" title="' + esc(t.name) + '"><span>' + t.icon + '</span><small>' + esc(t.name) + '</small></button>';
      }).join('') + '</div></div>' +
      '<label class="field"><span>สมาชิกทีม (ไม่บังคับ — เล่นเป็นทีม แชร์ token เดียวกัน)</span><input id="f-members" maxlength="80" placeholder="เช่น เอ, บี" ' + (full ? 'disabled' : '') + '></label>' +
      '<button class="btn primary wide" type="submit" ' + (full || !ui.lobbyToken ? 'disabled' : '') + '>+ เพิ่มผู้เล่น</button>' +
      (v.players.length === 0 ? '<button class="btn link" type="button" id="demo-players">เติมผู้เล่นตัวอย่าง 3 คน</button>' : '') +
      '</form>' +
      '<div class="box"><h3>ผู้เล่น <span class="muted">' + v.players.length + '/' + R.MAX_PLAYERS + '</span></h3>' +
      (v.players.length ? '<ul class="roster">' + v.players.map(function (p) {
        var t = B.tokenOf(p.token);
        return '<li style="--pc:' + t.color + '"><span class="ptoken">' + t.icon + '</span>' +
          '<div class="grow"><b>' + esc(p.name) + '</b>' + (p.members ? '<small>' + esc(p.members) + '</small>' : '') + '</div>' +
          '<button class="btn ' + (p.ready ? 'ok' : 'ghost') + ' sm" data-ready="' + p.id + '">' + (p.ready ? '✓ พร้อม' : 'กดพร้อม') + '</button>' +
          '<button class="btn ghost sm icon" data-remove="' + p.id + '" aria-label="ลบ ' + esc(p.name) + '">✕</button></li>';
      }).join('') + '</ul>' : '<p class="empty">ยังไม่มีผู้เล่น — เพิ่มอย่างน้อย 2 Traveler</p>') +
      '<button class="btn primary wide big" id="start-game" ' + (allReady ? '' : 'disabled') + '>เริ่มเกม ▶</button>' +
      '<p class="muted small">' + (v.players.length < R.MIN_PLAYERS ? 'ต้องมีอย่างน้อย 2 Traveler' :
        allReady ? 'ทุกคนพร้อมแล้ว! Trial แรกคือ Timeline 4' : 'รอทุกคนกด "พร้อม"') +
      ' · เล่นบนเครื่องเดียว (ส่งเครื่องให้ตอบทีละคน)</p>' +
      '</div></div>' +
      '<p class="lobby-foot"><button class="btn link" data-act="home">← หน้าแรก</button>' +
      '<button class="btn link" data-open="rules">อ่านกติกาฉบับย่อ</button></p>' +
      '</div>';
    keepInputs($('screen-lobby'), function () { $('screen-lobby').innerHTML = html; });
    var name = $('f-name');
    if (name && !full && document.activeElement !== name) name.focus();
  }

  function onLobbyClick(e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.token) { ui.lobbyToken = t.dataset.token; render(); return; }
    if (t.dataset.ready) {
      var p = player(store.view, t.dataset.ready);
      dispatch({ type: 'SET_READY', playerId: p.id, ready: !p.ready });
      return;
    }
    if (t.dataset.remove) { dispatch({ type: 'REMOVE_PLAYER', playerId: t.dataset.remove }); return; }
    if (t.dataset.act === 'leave-seat') { dispatch({ type: 'ROOM_LEAVE_SEAT' }); return; }
    if (t.dataset.mode) {
      var cur = store.view.mode;
      dispatch({ type: 'SET_MODE', mode: t.dataset.mode, target: cur.target || R.SPEED_RUN_DEFAULT });
      return;
    }
    if (t.dataset.target) { dispatch({ type: 'SET_MODE', mode: 'SPEED_RUN', target: Number(t.dataset.target) }); return; }
    if (t.dataset.act === 'home') { goHome(); return; }
    if (t.id === 'start-game') { ui.display = {}; dispatch({ type: 'START_GAME' }); return; }
    if (t.id === 'demo-players') {
      ['มะลิ', 'ภูผา', 'ดาว'].forEach(function (n, i) {
        dispatch({ type: 'ADD_PLAYER', name: n, token: R.TOKENS[i].id });
      });
    }
  }

  function onLobbySubmit(e) {
    e.preventDefault();
    if (isOnline()) { dispatch({ type: 'ADD_PLAYER', name: $('f-name').value, token: ui.lobbyToken }); return; }
    var ok = dispatch({ type: 'ADD_PLAYER', name: $('f-name').value, token: ui.lobbyToken, members: $('f-members').value });
    if (ok) {
      $('f-name').value = '';
      $('f-members').value = '';
      toast('เพิ่มผู้เล่นแล้ว', 'ok');
    }
  }

  // ------------------------------------------------------------ header / players / log

  function renderHeader(v) {
    var chips = [];
    chips.push(modeChip(v));
    if (v.trial) chips.push('<span class="chip">Trial #' + v.trial.no + '</span>');
    if (v.trial) chips.push('<span class="chip">Trial: ' + trialBadge(v.trial.type) + '</span>');
    if (v.phase === 'CHALLENGE') chips.push('<span class="chip warn">⚔ ' + esc(R.CHALLENGES[v.challenge.type].name) + '</span>');
    chips.push('<span class="chip">ผู้นำ: ' + v.leaders.map(function (id) { return who(v, id); }).join(' ') + '</span>');

    var status = '';
    if (v.phase === 'TRIAL_INPUT') status = 'ล็อกคำตอบแล้ว ' + Object.keys(v.trial.answers).length + '/' + v.players.length;
    else if (v.phase === 'TRIAL_RESULT') status = 'เปิดเฉลย';
    else if (v.phase === 'CHALLENGE') status = v.challenge.stage === 'PLAY' ? 'ตาของ ' + esc(player(v, v.pendingActors[0]).name) : (v.challenge.stage === 'RESULT' ? 'จบ Challenge' : 'เตรียม Challenge');
    else if (v.phase === 'TIEBREAK_CHOICE') status = 'เสมอที่ Finish';
    else if (v.phase === 'GAME_OVER') status = 'จบเกม';
    chips.push('<span class="chip status">' + status + '</span>');
    if (isOnline()) {
      chips.push('<span class="chip">ห้อง <b>' + esc(v.room.code) + '</b> <span class="net" data-net="' + store.net + '"></span></span>');
      if (!v.room.me) chips.push('<span class="chip">👀 ผู้ชม</span>');
    }

    var actions = isOnline()
      ? '<button class="btn ghost sm" data-copy="' + esc(NET.shareLink(v.room.code)) + '">ลิงก์เชิญ</button>' +
        '<button class="btn ghost sm" data-act="leave">ออกจากห้อง</button>'
      : '<button class="btn ghost sm" data-open="new">เกมใหม่</button>';
    $('topbar').innerHTML =
      '<div class="brand"><span class="logo" aria-hidden="true">⏳</span><h1>Timeline Challenge</h1></div>' +
      '<div class="chips">' + chips.join('') + '</div>' +
      '<div class="top-actions"><button class="btn ghost sm" data-open="rules">กติกา</button>' + actions + '</div>';
    renderNet();
  }

  function renderTimeline(v) {
    var hit = {};
    var t = v.trial;
    if (t && t.result && (t.type === 'T4' || t.type === 'BET')) {
      t.result.solution.spaces.forEach(function (list, i) {
        list.forEach(function (k) { hit[k] = (hit[k] || '') + (t.type === 'T4' ? SYM[i] : '✓'); });
      });
    }
    $('timeline-strip').innerHTML = B.timelineHTML(hit);
  }

  function renderPlayers(v) {
    var ch = v.challenge;
    $('players').innerHTML = v.players.map(function (p) {
      var tok = B.tokenOf(p.token);
      var badges = [];
      if (v.leaders.indexOf(p.id) !== -1 && v.phase !== 'GAME_OVER') badges.push('<span class="b lead">👑 ผู้นำ</span>');
      if (v.phase === 'TRIAL_INPUT') badges.push(v.trial.answers[p.id] ? '<span class="b ok">✓ ล็อกแล้ว</span>' : '<span class="b wait">⏳ ยังไม่ตอบ</span>');
      if (ch && ch.participants.indexOf(p.id) !== -1) {
        if (ch.eliminated.indexOf(p.id) !== -1) badges.push('<span class="b bad">✗ ตกรอบ</span>');
        else if (ch.winnerId === p.id) badges.push('<span class="b ok">🏅 ชนะ Challenge</span>');
        else badges.push('<span class="b warn">⚔ Challenge</span>');
      }
      if ((v.winners || []).indexOf(p.id) !== -1) badges.push('<span class="b win">🏆 ผู้ชนะ</span>');
      var mv = v.lastMoves && v.lastMoves[p.id];
      var acting = v.pendingActors.indexOf(p.id) !== -1 && v.phase === 'CHALLENGE';
      var members = isOnline() ? membersOf(v, p.id).map(memberLabel).join(', ') : esc(p.members || '');
      return '<div class="pcard' + (acting ? ' is-acting' : '') + (p.id === myId() ? ' is-me' : '') + '" style="--pc:' + tok.color + '">' +
        '<div class="ptoken">' + tok.icon + '</div><div class="pinfo">' +
        '<div class="pname">' + esc(p.name) + (p.id === myId() ? ' <span class="b lead">คุณ</span>' : '') + (members ? ' <small>' + members + '</small>' : '') + '</div>' +
        '<div class="ppos">' + scoreText(v, p) + (mv && mv.steps ? ' <span class="pmove">+' + mv.steps + '</span>' : '') + '</div>' +
        '<div class="pbar"><i style="width:' + Math.min(100, Math.round(p.position / v.goal * 100)) + '%"></i></div>' +
        '<div class="pbadges">' + badges.join('') + '</div></div></div>';
    }).join('');
  }

  function renderLog(v) {
    var items = v.log.slice(-40).reverse();
    var open = $('log').open;
    $('log').innerHTML = '<summary>บันทึกเกม (' + v.log.length + ')</summary><ol>' +
      items.map(function (l) { return '<li class="log-' + l.kind + '">' + esc(l.text) + '</li>'; }).join('') + '</ol>';
    $('log').open = open;
  }

  // ------------------------------------------------------------ pawn animation

  function animatePawns(v) {
    v.players.forEach(function (p) {
      var d = ui.display[p.id];
      if (d === undefined || d > p.position) ui.display[p.id] = p.position;
    });
    B.update(ui.board, v, ui.display);
    if (ui.animTimer) return;
    ui.animTimer = setInterval(function () {
      var cur = store.view, moving = false;
      if (!cur || cur.phase === 'LOBBY') { clearInterval(ui.animTimer); ui.animTimer = null; return; }
      cur.players.forEach(function (p) {
        if (ui.display[p.id] < p.position) { ui.display[p.id]++; moving = true; }
      });
      B.update(ui.board, cur, ui.display);
      if (!moving) {
        clearInterval(ui.animTimer); ui.animTimer = null;
        if (cur.phase === 'GAME_OVER') celebrate(cur);
      }
    }, STEP_MS);
  }

  function celebrate(v) {
    var key = v.seq;
    if (ui.celebrated === key) return;
    ui.celebrated = key;
    var host = $('confetti');
    var colors = ['#e2b93b', '#e5484d', '#3fbf6f', '#3b82f6', '#b061d6', '#f4f1ea'];
    var html = '';
    for (var i = 0; i < 90; i++) {
      html += '<i style="left:' + (Math.random() * 100) + '%;background:' + colors[i % colors.length] +
        ';animation-delay:' + (Math.random() * 0.8).toFixed(2) + 's;animation-duration:' + (2.2 + Math.random() * 1.8).toFixed(2) + 's"></i>';
    }
    host.innerHTML = html;
    setTimeout(function () { host.innerHTML = ''; }, 4800);
  }

  // ------------------------------------------------------------ action panel

  function renderPanel(v) {
    var html;
    switch (v.phase) {
      case 'TRIAL_INPUT': html = panelTrialInput(v); break;
      case 'TRIAL_RESULT': html = panelTrialResult(v); break;
      case 'CHALLENGE': html = panelChallenge(v); break;
      case 'TIEBREAK_CHOICE': html = panelTie(v); break;
      case 'GAME_OVER': html = panelGameOver(v); break;
      default: html = '';
    }
    keepInputs($('panel'), function () { $('panel').innerHTML = html; });
    var input = $('mol-year');
    if (input) input.focus();
  }

  function trialHead(v, suffix) {
    var t = R.TRIALS[v.trial.type];
    return '<div class="phead" style="--tc:' + B.COLORS[t.color] + '">' +
      '<div class="phead-top"><span class="muted">Trial #' + v.trial.no + '</span>' + (suffix ? '<span class="pill">' + suffix + '</span>' : '') + '</div>' +
      '<h2>' + esc(t.name) + '</h2><p>' + esc(t.help) + '</p></div>';
  }

  function trialCards(v, notes) {
    var t = v.trial;
    var useSym = t.type === 'T4' || t.type === 'COMB';
    return '<div class="cards cards-' + t.cardIds.length + '">' + t.cardIds.map(function (id, i) {
      return cardHTML(v.cards[id], { symbol: useSym ? SYM[i] : null, note: notes ? notes[i] : null });
    }).join('') + '</div>';
  }

  function panelTrialInput(v) {
    var t = v.trial;
    var rows = v.players.map(function (p) {
      var locked = !!t.answers[p.id];
      var status = locked ? '<span class="b ok">✓ ล็อกคำตอบแล้ว</span>'
        : canActFor(p.id) ? '<button class="btn primary sm" data-answer="' + p.id + '">' + (isOnline() ? 'ตอบคำถาม' : 'ตอบ (ลับ)') + '</button>'
        : '<span class="b wait">⏳ กำลังตอบ…</span>';
      return '<li>' + who(v, p.id) + status + '</li>';
    }).join('');
    return trialHead(v) + trialCards(v) +
      '<div class="box answers"><h3>' + (isOnline() ? 'คำตอบของผู้เล่น' : 'ส่งเครื่องให้ผู้เล่นตอบทีละคน') + '</h3><ul class="answer-list">' + rows + '</ul>' +
      '<p class="muted small">คำตอบเป็นความลับ เฉลยจะเปิดพร้อมกันเมื่อทุกคนล็อกคำตอบครบ</p></div>';
  }

  function panelTrialResult(v) {
    var t = v.trial, res = t.result, sol = res.solution;
    var notes = null, solText = '';
    if (t.type === 'T4') {
      notes = sol.spaces.map(function (list) { return 'ช่อง ' + list.join(' หรือ '); });
    } else if (t.type === 'BET') {
      solText = 'คำตอบ: ช่อง ' + sol.spaces[0].join(' หรือ ') + ' (' + sol.spaces[0].map(R.spaceRangeLabel).join(' / ') + ')';
    } else if (t.type === 'SPLIT') {
      solText = 'ห่างกัน ' + sol.distance + ' ปี';
    } else if (t.type === 'RD') {
      solText = 'คำตอบ: ' + (sol.sign === '-' ? '−' : '+') + sol.digits.join('');
    } else if (t.type === 'COMB') {
      notes = sol.ranks.map(function (r) { return 'ลำดับ ' + r.join(' หรือ '); });
    }
    var rows = v.players.map(function (p) {
      var a = t.answers[p.id], r = res.players[p.id], mv = v.lastMoves[p.id];
      var cells = '';
      if (t.type === 'RD') cells += '<span class="ans ' + (r.signOk ? 'ok' : 'bad') + '">' + (a.sign === '-' ? '−' : '+') + '</span>';
      if (t.type === 'SPLIT') {
        cells = '<span class="ans ' + (r.closest ? 'ok' : 'bad') + ' wide">' + r.guess + ' ปี</span><span class="muted small">คลาด ' + r.off + '</span>';
      } else {
        a.wheels.forEach(function (w, i) {
          cells += '<span class="ans ' + (r.correct[i] ? 'ok' : 'bad') + '">' + (t.type === 'T4' || t.type === 'COMB' ? '<sup>' + SYM[i] + '</sup>' : '') + w + '</span>';
        });
      }
      return '<tr><td>' + who(v, p.id) + '</td><td class="cells">' + cells + '</td>' +
        '<td class="pts">' + (mv.steps ? '+' + mv.steps : '0') + '</td>' +
        '<td class="mv">' + mv.from + ' → <b>' + mv.to + '</b>' + (mv.to >= R.FINISH ? ' 🏁' : '') + '</td></tr>';
    }).join('');
    return trialHead(v, 'เฉลย') + trialCards(v, notes) +
      (solText ? '<div class="solution">' + esc(solText) + '</div>' : '') +
      '<table class="results"><thead><tr><th>ผู้เล่น</th><th>คำตอบ</th><th>เดิน</th><th>ช่อง</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      continueButton();
  }

  /** In online games any seated player may advance; spectators only watch. */
  function continueButton() {
    return isSeated()
      ? '<button class="btn primary wide big" data-act="continue">ไปต่อ ▶</button>'
      : '<p class="muted center">รอผู้เล่นกดไปต่อ…</p>';
  }

  function panelChallenge(v) {
    var ch = v.challenge, spec = R.CHALLENGES[ch.type];
    var head = '<div class="phead challenge">' +
      '<div class="phead-top"><span class="muted">' + (ch.purpose === 'TIEBREAK' ? 'ไทเบรกตัดสินผู้ชนะ' : 'Challenge — ผู้นำข้ามเส้น') + '</span></div>' +
      '<h2>' + (ch.type === 'SUDDEN_DEATH' ? '☠ ' : '± ') + esc(spec.name) + '</h2><p>' + esc(spec.help) +
      (ch.purpose === 'TIEBREAK' ? ' (ไทเบรก: ผู้ชนะ Challenge ชนะเกม)' : '') + '</p></div>';
    var order = '<ol class="order">' + ch.participants.map(function (pid) {
      var cls = ch.eliminated.indexOf(pid) !== -1 ? 'out' : (v.pendingActors[0] === pid ? 'now' : '');
      return '<li class="' + cls + '">' + who(v, pid) + '</li>';
    }).join('') + '</ol>';

    if (ch.stage === 'INTRO') {
      return head + '<div class="box"><h3>ผู้เข้าร่วม (เรียงตามลำดับการเล่น)</h3>' + order +
        (ch.type === 'MORE_OR_LESS' ? '<p class="muted small">กรรมการ: ' + who(v, ch.leaderId) + ' — ระบบจะตอบ "มากกว่า / น้อยกว่า" แทน</p>' : '') +
        '<p class="muted small">ผู้ที่อยู่หลังสุดเริ่มก่อน แล้ววนตามเข็มนาฬิกา</p></div>' +
        (isSeated() ? '<button class="btn primary wide big" data-act="begin">เริ่ม Challenge ▶</button>' : '<p class="muted center">รอผู้เล่นเริ่ม Challenge…</p>');
    }

    var body = '';
    if (ch.type === 'SUDDEN_DEATH') body = sdBody(v, ch);
    else body = molBody(v, ch);

    if (ch.stage === 'RESULT') {
      var mv = ch.move;
      body += '<div class="result-banner">🏅 ' + who(v, ch.winnerId) + ' ชนะ!' +
        (ch.purpose === 'TIEBREAK' ? ' — ชนะเกม' : (mv && mv.steps ? ' เดิน ' + mv.steps + ' ช่อง (' + mv.from + ' → ' + mv.to + ')' : ' — ผู้นำชนะ จึงไม่มีใครเดิน')) + '</div>' +
        continueButton();
    }
    return head + '<div class="box"><h3>ลำดับการเล่น</h3>' + order + '</div>' + body;
  }

  function sdBody(v, ch) {
    var cur = v.pendingActors[0];
    var tl = ch.sd.timeline;
    var html = '';
    var lp = ch.sd.lastPlacement;
    if (lp) {
      html += '<div class="flash ' + (lp.correct ? 'ok' : 'bad') + '">' + who(v, lp.playerId) +
        (lp.correct ? ' วางถูก ✓' : ' วางผิด ✗ ตกรอบ') + ' — ' + esc(v.cards[lp.cardId].title) + ' (' + esc(R.formatYear(v.cards[lp.cardId].year)) + ')</div>';
    }
    var myTurn = ch.stage === 'PLAY' && canActFor(cur);
    if (ch.stage === 'PLAY') {
      html += '<div class="turn-banner">ตาของ ' + who(v, cur) +
        (myTurn ? ' — เลือกตำแหน่งวางการ์ดใบนี้ใน timeline' : ' — รอวางการ์ด…') + '</div>' +
        '<div class="sd-hand">' + cardHTML(v.cards[ch.sd.currentCardId], { extraClass: 'card-hand' }) + '</div>';
    }
    html += '<div class="sd-line">';
    for (var i = 0; i <= tl.length; i++) {
      if (myTurn) {
        html += '<button class="slot" data-slot="' + i + '" title="วางที่นี่">' +
          '<span>' + (i === 0 ? 'ก่อนสุด' : i === tl.length ? 'หลังสุด' : 'ระหว่าง') + '</span>▼</button>';
      }
      if (i < tl.length) html += cardHTML(v.cards[tl[i]], { small: true });
    }
    return html + '</div>';
  }

  function molBody(v, ch) {
    var cur = v.pendingActors[0];
    var card = v.cards[ch.mol.cardId];
    var html = '<div class="mol-card">' + cardHTML(card, {}) +
      '<p class="muted small">กรรมการ ' + who(v, ch.leaderId) + ' อ่านชื่อการ์ด — ทายปีให้ตรง</p></div>';
    html += '<ul class="guesses">' + ch.mol.guesses.map(function (g) {
      var verdict = { more: '⬆ มากกว่า', less: '⬇ น้อยกว่า', exact: '🎯 ถูกต้อง!' }[g.verdict];
      return '<li class="' + g.verdict + '">' + who(v, g.playerId) + ' <b>' + esc(R.formatYear(g.year)) + '</b> <span>' + verdict + '</span></li>';
    }).join('') + '</ul>';
    if (ch.stage === 'PLAY' && !canActFor(cur)) {
      html += '<div class="turn-banner">ตาของ ' + who(v, cur) + ' — รอทายปี…</div>';
    } else if (ch.stage === 'PLAY') {
      html += '<form class="mol-form" id="mol-form"><label><span>ตาของ ' + who(v, cur) + ' — ทายปี</span>' +
        '<input id="mol-year" type="number" inputmode="numeric" step="1" min="-9999" max="9999" placeholder="เช่น 1750 หรือ -300" required></label>' +
        '<button class="btn primary" type="submit">ทาย</button></form>';
    }
    return html;
  }

  function panelTie(v) {
    var where = v.mode.type === 'SPEED_RUN' ? 'ได้ ' + v.goal + ' แต้มพร้อมกัน' : 'ถึง Finish พร้อมกัน';
    return '<div class="phead"><h2>เสมอ!</h2><p>' +
      v.tie.playerIds.map(function (id) { return who(v, id); }).join(' ') + ' ' + where + '</p></div>' +
      '<div class="box"><p>ตามกติกา: จะจับมือชนะร่วมกัน หรือตัดสินด้วย Challenge "Sudden Death"</p>' +
      (!isOnline() || amHost() || v.tie.playerIds.indexOf(myId()) !== -1
        ? '<div class="row"><button class="btn ghost big" data-tie="SHARE">🤝 ชนะร่วมกัน</button>' +
          '<button class="btn primary big" data-tie="SUDDEN_DEATH">☠ ตัดสินด้วย Sudden Death</button></div>'
        : '<p class="muted center">รอผู้เล่นที่เสมอกันตัดสินใจ…</p>') + '</div>';
  }

  function panelGameOver(v) {
    var ranking = v.players.slice().sort(function (a, b) { return b.position - a.position; });
    return '<div class="winner">' +
      '<div class="trophy">🏆</div><h2>' + v.winners.map(function (id) { return who(v, id); }).join(' และ ') + '</h2>' +
      '<p>' + (v.winners.length > 1 ? 'ชนะร่วมกัน!' : v.mode.type === 'SPEED_RUN'
        ? 'ได้ ' + v.goal + ' แต้มเป็นคนแรก — ชนะ Speed Run!' : 'ถึง Finish เป็นคนแรก — ชนะเกม!') + '</p></div>' +
      '<ol class="ranking">' + ranking.map(function (p) {
        return '<li>' + who(v, p.id) + '<span>' + (v.mode.type === 'SPEED_RUN' ? p.position + ' แต้ม'
          : p.position >= R.FINISH ? 'Finish' : 'ช่อง ' + p.position) + '</span></li>';
      }).join('') + '</ol>' +
      (isOnline()
        ? '<div class="row">' + (amHost() ? '<button class="btn primary big" data-act="rematch">เล่นอีกครั้ง (ผู้เล่นเดิม)</button>' : '<p class="muted">รอหัวห้องเริ่มเกมใหม่</p>') +
          '<button class="btn ghost big" data-act="leave">ออกจากห้อง</button></div>'
        : '<div class="row"><button class="btn primary big" data-act="rematch">เล่นอีกครั้ง (ผู้เล่นเดิม)</button>' +
          '<button class="btn ghost big" data-act="fresh">ล้างผู้เล่น เริ่มใหม่</button></div>');
  }

  function onPanelClick(e) {
    var b = e.target.closest('button');
    if (!b) return;
    var v = store.view;
    if (b.dataset.answer) {
      // Online, each player answers on their own device, so the pass-the-device screen is skipped.
      ui.modal = { kind: 'answer', playerId: b.dataset.answer, step: isOnline() ? 'input' : 'privacy' };
      render();
      return;
    }
    if (b.dataset.slot !== undefined) {
      dispatch({ type: 'SD_PLACE', playerId: v.pendingActors[0], slot: Number(b.dataset.slot) });
      return;
    }
    if (b.dataset.tie) { dispatch({ type: 'RESOLVE_TIE', mode: b.dataset.tie }); return; }
    switch (b.dataset.act) {
      case 'continue': dispatch({ type: 'CONTINUE' }); break;
      case 'begin': dispatch({ type: 'CHALLENGE_BEGIN' }); break;
      case 'rematch': rematch(); break;
      case 'fresh': fresh(); break;
    }
  }

  function onPanelSubmit(e) {
    if (e.target.id !== 'mol-form') return;
    e.preventDefault();
    var raw = $('mol-year').value.trim();
    var year = Number(raw);
    if (raw === '' || !Number.isInteger(year)) { toast('กรุณาใส่ปีเป็นจำนวนเต็ม', 'error'); return; }
    dispatch({ type: 'MOL_GUESS', playerId: store.view.pendingActors[0], year: year });
  }

  // ------------------------------------------------------------ modals

  function renderModal(v) {
    var m = ui.modal;
    var host = $('modal');
    // A pending answer modal becomes stale if the game moved on or the player already locked.
    if (m && m.kind === 'answer' && (!v || v.phase !== 'TRIAL_INPUT' || v.trial.answers[m.playerId] || !canActFor(m.playerId))) m = ui.modal = null;
    var sheetKey = m && m.kind === 'answer' && m.step === 'input' ? draftKey(v, m.playerId) : '';
    if (sheetKey && host.dataset.sheet === sheetKey) {
      // This player's answer sheet is already open for this Trial. Updates about *other*
      // players (someone locked, joined, reconnected…) must not rebuild it: that would
      // throw away the wheels this player is still setting.
      return;
    }
    host.dataset.sheet = sheetKey;
    if (!m) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;

    if (m.kind === 'answer') {
      var p = player(v, m.playerId), tok = B.tokenOf(p.token);
      if (m.step === 'privacy') {
        host.innerHTML = '<div class="sheet privacy" style="--pc:' + tok.color + '" role="dialog" aria-modal="true">' +
          '<div class="big-token">' + tok.icon + '</div><h2>ส่งเครื่องให้ ' + esc(p.name) + '</h2>' +
          '<p>ผู้เล่นคนอื่นห้ามดูหน้าจอ — คำตอบเป็นความลับจนกว่าทุกคนจะล็อก</p>' +
          '<div class="row"><button class="btn ghost" data-m="close">ยกเลิก</button>' +
          '<button class="btn primary big" data-m="reveal">ฉันคือ ' + esc(p.name) + ' — แสดงโจทย์</button></div></div>';
        host.querySelector('[data-m="reveal"]').focus();
      } else {
        var t = v.trial, useSym = t.type === 'T4' || t.type === 'COMB';
        host.innerHTML = '<div class="sheet answer" style="--pc:' + tok.color + '" role="dialog" aria-modal="true">' +
          '<div class="sheet-head"><span class="ptoken">' + tok.icon + '</span><div><b>' + esc(p.name) + '</b> · ' + trialBadge(t.type) +
          '<div class="muted small">' + esc(R.TRIALS[t.type].help) + '</div></div></div>' +
          '<div class="cards cards-' + t.cardIds.length + ' compact">' + t.cardIds.map(function (id, i) {
            return cardHTML(v.cards[id], { small: true, symbol: useSym ? SYM[i] : null });
          }).join('') + '</div>' +
          (t.type === 'T4' || t.type === 'BET' ? B.timelineHTML({}) : '') +
          '<div id="wheels-host"></div></div>';
        TC.UI.Wheels.mount($('wheels-host'), t.type, t.cardIds.map(function (id) { return v.cards[id]; }),
          function (answer) {
            ui.modal = null;
            if (dispatch({ type: 'SUBMIT_ANSWER', playerId: p.id, answer: answer })) toast(p.name + ' ล็อกคำตอบแล้ว', 'ok');
          },
          function () { ui.modal = null; render(); },
          { initial: ui.drafts[sheetKey], onChange: function (draft) { ui.drafts[sheetKey] = draft; } });
        var first = host.querySelector('.wheel');
        if (first) first.focus();
      }
      return;
    }

    if (m.kind === 'rules') {
      host.innerHTML = '<div class="sheet rules" role="dialog" aria-modal="true"><button class="btn ghost sm close" data-m="close" aria-label="ปิด">✕</button>' + RULES_HTML + '</div>';
      return;
    }

    if (m.kind === 'new') {
      host.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><h2>เริ่มเกมใหม่?</h2><p>เกมที่เล่นอยู่จะหายไป</p>' +
        '<div class="row"><button class="btn ghost" data-m="close">ยกเลิก</button>' +
        '<button class="btn ghost" data-m="fresh">ล้างผู้เล่นทั้งหมด</button>' +
        '<button class="btn primary" data-m="rematch">กลับห้องรอ (ผู้เล่นเดิม)</button></div></div>';
    }
  }

  function onModalClick(e) {
    if (e.target.id === 'modal' && ui.modal && ui.modal.kind !== 'answer') { ui.modal = null; render(); return; }
    var b = e.target.closest('[data-m]');
    if (!b) return;
    switch (b.dataset.m) {
      case 'close': ui.modal = null; render(); break;
      case 'reveal': ui.modal.step = 'input'; render(); break;
      case 'rematch': rematch(); break;
      case 'fresh': fresh(); break;
    }
  }

  var RULES_HTML =
    '<h2>กติกาฉบับย่อ</h2>' +
    '<p><b>เป้าหมาย:</b> ถึงช่อง Finish เป็นคนแรก โดยผ่าน Trial และ Challenge เกี่ยวกับปีของเหตุการณ์</p>' +
    '<h3>Trial</h3><p>ทุกคนเล่นทุก Trial พร้อมกัน ตอบลับด้วย Historical Board แล้วเปิดเฉลยพร้อมกัน ' +
    '<b>ช่องที่ผู้นำยืนอยู่เป็นตัวกำหนด Trial ถัดไป</b> (Trial แรกคือ Timeline 4 เสมอ)</p><ul>' +
    Object.keys(R.TRIALS).map(function (k) {
      var t = R.TRIALS[k];
      return '<li>' + trialBadge(k) + ' <span class="muted">(' + t.cards + ' การ์ด)</span> ' + esc(t.help) + '</li>';
    }).join('') + '</ul>' +
    '<h3>Timeline บนกระดาน</h3>' + '<div class="rules-tl">' +
    R.TIMELINE_DATES.concat([null]).map(function (d, k) { return '<span><b>' + k + '</b> ' + esc(R.spaceRangeLabel(k)) + '</span>'; }).join('') + '</div>' +
    '<h3>Challenge</h3><p>เมื่อผู้นำข้ามเส้น Challenge (เล่นเส้นละครั้งเดียว) ผู้เล่น <b>สองคนที่อยู่หลังสุด</b> แข่งกัน ' +
    '(ถ้ามีหลายคนอยู่ช่องเดียวกันในอันดับสุดท้าย/รองสุดท้าย เข้าร่วมทั้งหมด) คนที่อยู่หลังสุดเริ่มก่อน ผู้ชนะเดิน 3 ช่อง</p><ul>' +
    '<li><b>☠ Sudden Death</b> (หลังช่อง 6): ' + esc(R.CHALLENGES.SUDDEN_DEATH.help) + '</li>' +
    '<li><b>± More or Less</b> (หลังช่อง 13): ' + esc(R.CHALLENGES.MORE_OR_LESS.help) + '</li></ul>' +
    '<h3>จบเกม</h3><p>เกมจบทันทีที่มีคนถึง Finish ถ้าถึงพร้อมกันหลายคน เลือกชนะร่วมกันหรือตัดสินด้วย Sudden Death</p>' +
    '<h3>2 ผู้เล่น</h3><p>ไม่มี More or Less และใน Sudden Death เฉพาะคนที่ตามหลังเท่านั้นที่ได้เดิน 3 ช่อง (ผู้นำชนะ = กันไม่ให้อีกฝ่ายเดิน)</p>' +
    '<p class="muted small">อ้างอิง: rulebook ทางการของ Timeline Challenge (Asmodee) — รายละเอียดใน RULES.md</p>';

  // ------------------------------------------------------------ boot

  function boot() {
    $('screen-home').addEventListener('click', onHomeClick);
    $('screen-home').addEventListener('submit', onHomeSubmit);
    $('screen-lobby').addEventListener('click', onLobbyClick);
    $('screen-lobby').addEventListener('submit', onLobbySubmit);
    $('panel').addEventListener('click', onPanelClick);
    $('panel').addEventListener('submit', onPanelSubmit);
    $('modal').addEventListener('click', onModalClick);
    document.addEventListener('click', function (e) {
      var o = e.target.closest('[data-open]');
      if (o) { ui.modal = { kind: o.dataset.open }; render(); return; }
      var c = e.target.closest('[data-copy]');
      if (c) { copyText(c.dataset.copy); return; }
      var l = e.target.closest('[data-act="leave"]');
      if (l) leaveRoom();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.modal) { ui.modal = null; render(); }
    });
    // Local mode only: keep several tabs of one browser showing the same pass-and-play game.
    window.addEventListener('storage', function (e) {
      if (store.mode !== 'local' || e.key !== STORAGE_KEY) return;
      var s = G.restore(e.newValue);
      if (s) { store.state = s; render(); }
    });

    // Refresh / reopen: this tab's identity reconnects to the same room and seat.
    var code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    var session = NET.available() ? NET.session() : null;
    if (session && (!code || session.code === code)) {
      store.mode = 'online';   // shows "connecting" until the first snapshot arrives
      render();
      joinOrReconnect(NET.joinRoom(session.code, session.name, session.token)).then(function (r) {
        if (!r.ok) goHome();
      });
      return;
    }
    render();
  }

  TC.UI.App = { boot: boot, dispatch: dispatch, store: store };
  document.addEventListener('DOMContentLoaded', boot);
})(window);
