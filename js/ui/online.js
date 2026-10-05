/*
 * Online transport — talks to server/server.py.
 * Actions go up as HTTP POSTs; the server pushes this client's view down over Server-Sent Events.
 * Browser storage only remembers *who you are* in a room (to reconnect after refresh), never game state.
 */
(function (root) {
  'use strict';
  var TC = root.TC;

  var SESSION_KEY = 'tc.online.session';   // this tab's identity (survives refresh)
  var LAST_KEY = 'tc.online.last';         // last identity, offered after the tab was closed

  var conn = { code: null, token: null, es: null, onView: null, onStatus: null };

  function readJSON(storage, key) {
    try { return JSON.parse(storage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function writeJSON(storage, key, value) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage blocked: reconnect after refresh won't be automatic */ }
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ' }; });
    }, function () {
      return { ok: false, error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' };
    });
  }

  function remember(code, token, name) {
    var id = { code: code, token: token, name: name };
    writeJSON(sessionStorage, SESSION_KEY, id);
    writeJSON(localStorage, LAST_KEY, id);
  }

  function available() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function createRoom(name) {
    return post('/api/rooms', { name: name }).then(function (r) {
      if (r.ok) remember(r.code, r.token, name);
      return r;
    });
  }

  /** Join by code; with a known token this is a reconnect to the same seat. */
  function joinRoom(code, name, token) {
    return post('/api/rooms/' + encodeURIComponent(code) + '/join', { name: name, token: token }).then(function (r) {
      if (r.ok) remember(r.code, r.token, r.name);
      return r;
    });
  }

  function connect(code, token, onView, onStatus) {
    disconnect();
    conn.code = code; conn.token = token; conn.onView = onView; conn.onStatus = onStatus;
    var es = new EventSource('/api/rooms/' + encodeURIComponent(code) + '/stream?token=' + encodeURIComponent(token));
    conn.es = es;
    onStatus('connecting');
    es.onopen = function () { onStatus('online'); };
    es.onmessage = function (e) {
      try { onView(JSON.parse(e.data)); } catch (err) { /* ignore malformed frame */ }
    };
    es.onerror = function () { onStatus(es.readyState === 2 ? 'offline' : 'reconnecting'); };
  }

  function disconnect() {
    if (conn.es) conn.es.close();
    conn.es = null;
  }

  function leave() {
    disconnect();
    conn.code = conn.token = null;
    writeJSON(sessionStorage, SESSION_KEY, null);
  }

  function send(action) {
    return post('/api/rooms/' + encodeURIComponent(conn.code) + '/action', { token: conn.token, action: action });
  }

  function shareLink(code) {
    return location.origin + location.pathname + '?room=' + encodeURIComponent(code);
  }

  TC.UI = TC.UI || {};
  TC.UI.Online = {
    available: available,
    createRoom: createRoom,
    joinRoom: joinRoom,
    connect: connect,
    disconnect: disconnect,
    leave: leave,
    send: send,
    shareLink: shareLink,
    session: function () { return readJSON(sessionStorage, SESSION_KEY); },
    last: function () { return readJSON(localStorage, LAST_KEY); },
    forgetLast: function () { writeJSON(localStorage, LAST_KEY, null); }
  };
})(window);
