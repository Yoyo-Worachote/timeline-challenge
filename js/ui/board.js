/*
 * Board view — the Clock (SVG) and the Timeline strip. Pure rendering: reads a view, never rules.
 * Space coordinates follow the board illustration in the official rulebook.
 */
(function (root) {
  'use strict';
  var TC = root.TC;
  var R = TC.Rules;
  var NS = 'http://www.w3.org/2000/svg';

  var COORDS = [
    [645, 195], [850, 240], [995, 380], [1060, 580], [1060, 755], [970, 915], [810, 1045],
    [610, 1080], [420, 1040], [270, 910], [190, 745], [205, 545], [330, 395], [505, 345],
    [680, 370], [810, 510], [840, 690], [745, 820], [590, 860], [420, 800], [405, 625],
    [612, 610] // Finish
  ];
  var LINES = {
    SUDDEN_DEATH: { from: [700, 985], to: [722, 1140], icon: [690, 975], glyph: '☠' },
    MORE_OR_LESS: { from: [592, 455], to: [610, 290], icon: [590, 455], glyph: '±' }
  };
  var ICON = { T4: '????', BET: '?', SPLIT: '?|?', COMB: '1234' };
  var COLORS = { green: '#3fbf6f', red: '#e5484d', blue: '#3b82f6', yellow: '#e2b93b', purple: '#b061d6' };
  /**
   * Pawns sharing a space sit on a ring around it, sized so neighbouring pawns don't overlap;
   * crowded spaces (up to 10 pawns) use smaller pawns.
   */
  function pawnPlace(k, n) {
    if (n === 1) return { x: 0, y: -34, s: 1 };
    var s = n <= 4 ? 1 : n <= 6 ? 0.8 : 0.7;
    var r = Math.max(30, (PAWN_DIAMETER * s) / (2 * Math.sin(Math.PI / n)));
    var a = -Math.PI / 2 + k * 2 * Math.PI / n;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, s: s };
  }
  var PAWN_DIAMETER = 54;   // circle r=27 below

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(n);
    return n;
  }

  function trialColor(type) {
    return COLORS[R.TRIALS[type].color];
  }

  function create(container) {
    var svg = el('svg', { viewBox: '90 100 1080 1080', class: 'clock', role: 'img', 'aria-label': 'กระดาน Clock' });
    var defs = el('defs', {}, svg);
    var pat = el('pattern', { id: 'checker', width: 36, height: 36, patternUnits: 'userSpaceOnUse' }, defs);
    el('rect', { width: 36, height: 36, fill: '#f4f1ea' }, pat);
    el('rect', { width: 18, height: 18, fill: '#15161a' }, pat);
    el('rect', { x: 18, y: 18, width: 18, height: 18, fill: '#15161a' }, pat);
    var glow = el('radialGradient', { id: 'face' }, defs);
    el('stop', { offset: '0%', 'stop-color': '#2a2620' }, glow);
    el('stop', { offset: '100%', 'stop-color': '#16140f' }, glow);

    el('circle', { cx: 630, cy: 640, r: 535, class: 'clock-rim' }, svg);
    el('circle', { cx: 630, cy: 640, r: 515, fill: 'url(#face)', class: 'clock-face' }, svg);
    for (var t = 0; t < 60; t++) {
      var a = t / 60 * Math.PI * 2, long = t % 5 === 0;
      el('line', {
        x1: 630 + Math.cos(a) * (long ? 480 : 495), y1: 640 + Math.sin(a) * (long ? 480 : 495),
        x2: 630 + Math.cos(a) * 508, y2: 640 + Math.sin(a) * 508, class: 'tick'
      }, svg);
    }

    el('polyline', { points: COORDS.map(function (c) { return c.join(','); }).join(' '), class: 'track-path' }, svg);

    Object.keys(LINES).forEach(function (id) {
      var L = LINES[id];
      var g = el('g', { class: 'challenge-line', 'data-challenge': id }, svg);
      el('line', { x1: L.from[0], y1: L.from[1], x2: L.to[0], y2: L.to[1] }, g);
      el('circle', { cx: L.icon[0], cy: L.icon[1], r: 30 }, g);
      var tx = el('text', { x: L.icon[0], y: L.icon[1] + 12 }, g);
      tx.textContent = L.glyph;
      var title = el('title', {}, g);
      title.textContent = 'เส้น Challenge: ' + R.CHALLENGES[id].name;
    });

    var spaces = [];
    COORDS.forEach(function (c, i) {
      var type = R.TRACK[i];
      var g = el('g', { class: 'space', 'data-space': i, transform: 'translate(' + c[0] + ',' + c[1] + ')' }, svg);
      if (type === 'FINISH') {
        el('circle', { r: 78, class: 'finish-ring' }, g);
        el('circle', { r: 66, fill: 'url(#checker)' }, g);
        var ft = el('text', { y: 104, class: 'space-label' }, g);
        ft.textContent = 'FINISH';
      } else {
        var col = trialColor(type);
        el('circle', { r: 60, class: 'space-glow', fill: col }, g);
        el('circle', { r: 54, class: 'space-disc', stroke: col }, g);
        if (type === 'RD') {
          // The Right Date: a clock face, like the board's icon.
          el('circle', { cy: -6, r: 19, fill: 'none', stroke: col, 'stroke-width': 5 }, g);
          el('path', { d: 'M0,-6 L0,-19 M0,-6 L9,0', stroke: col, 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
        } else {
          var ic = el('text', { y: type === 'COMB' || type === 'T4' ? 11 : 15, class: 'space-icon space-icon-' + type, fill: col }, g);
          ic.textContent = ICON[type];
        }
        var num = el('text', { y: 40, class: 'space-num' }, g);
        num.textContent = i === 0 ? 'START' : i;
      }
      var tt = el('title', {}, g);
      tt.textContent = type === 'FINISH' ? 'Finish' : (i === 0 ? 'Start — ' : 'ช่อง ' + i + ' — ') + R.TRIALS[type].name;
      spaces.push(g);
    });

    var pawnLayer = el('g', { class: 'pawns' }, svg);
    container.innerHTML = '';
    container.appendChild(svg);
    return { svg: svg, spaces: spaces, pawnLayer: pawnLayer, pawns: {} };
  }

  /**
   * @param board    from create()
   * @param view     engine view
   * @param display  { playerId: position } currently drawn (animated toward the real one)
   */
  function update(board, view, display) {
    var leaderPos = -1;
    view.players.forEach(function (p) { leaderPos = Math.max(leaderPos, p.position); });
    var speedGoal = view.mode && view.mode.type === 'SPEED_RUN' ? view.goal : -1;
    board.spaces.forEach(function (g, i) {
      g.classList.toggle('is-leader', i === leaderPos && view.phase !== 'LOBBY');
      g.classList.toggle('is-goal', i === speedGoal);
    });
    Object.keys(view.challengesPlayed || {}).forEach(function (id) {
      var g = board.svg.querySelector('[data-challenge="' + id + '"]');
      if (g) g.classList.toggle('is-played', !!view.challengesPlayed[id]);
    });

    var seen = {};
    var bySpace = {};
    view.players.forEach(function (p) {
      var pos = display[p.id] === undefined ? p.position : display[p.id];
      (bySpace[pos] = bySpace[pos] || []).push(p);
    });
    Object.keys(bySpace).forEach(function (pos) {
      var group = bySpace[pos];
      group.forEach(function (p, k) {
        seen[p.id] = true;
        var tok = tokenOf(p.token);
        var g = board.pawns[p.id];
        if (!g) {
          g = el('g', { class: 'pawn', 'data-player': p.id }, board.pawnLayer);
          el('circle', { r: 27, fill: tok.color }, g);
          var t = el('text', { y: 10 }, g);
          t.textContent = tok.icon;
          el('title', {}, g);
          board.pawns[p.id] = g;
        }
        g.querySelector('title').textContent = p.name + ' — ช่อง ' + p.position;
        var c = COORDS[pos];
        var at = pawnPlace(k, group.length);
        g.style.transform = 'translate(' + (c[0] + at.x) + 'px,' + (c[1] + at.y) + 'px) scale(' + at.s + ')';
        g.classList.toggle('is-winner', (view.winners || []).indexOf(p.id) !== -1);
      });
    });
    Object.keys(board.pawns).forEach(function (pid) {
      if (!seen[pid]) { board.pawns[pid].remove(); delete board.pawns[pid]; }
    });
  }

  function tokenOf(id) {
    for (var i = 0; i < R.TOKENS.length; i++) if (R.TOKENS[i].id === id) return R.TOKENS[i];
    return R.TOKENS[0];
  }

  /** The Timeline strip: spaces 0-9 between the nine board dates. */
  function timelineHTML(highlight) {
    highlight = highlight || {};
    var html = '<div class="timeline" role="list" aria-label="Timeline">';
    for (var k = 0; k <= R.TIMELINE_DATES.length; k++) {
      var cls = 'tl-space' + (highlight[k] ? ' is-hit' : '');
      html += '<div class="' + cls + '" role="listitem" title="ช่อง ' + k + ': ' + R.spaceRangeLabel(k) + '">' +
        '<b>' + k + '</b>' + (highlight[k] ? '<i>' + highlight[k] + '</i>' : '') + '</div>';
      if (k < R.TIMELINE_DATES.length) html += '<div class="tl-date">' + R.formatYear(R.TIMELINE_DATES[k]) + '</div>';
    }
    return html + '</div>';
  }

  TC.UI = TC.UI || {};
  TC.UI.Board = {
    create: create,
    update: update,
    timelineHTML: timelineHTML,
    tokenOf: tokenOf,
    trialColor: trialColor,
    COLORS: COLORS
  };
})(window);
