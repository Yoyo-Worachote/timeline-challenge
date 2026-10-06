/*
 * Movement Engine — pawn positions on the Clock and leader detection.
 * Players are kept in seat order (clockwise), which the Challenge turn order relies on.
 */
(function (root) {
  'use strict';
  var TC = root.TC;
  var R = TC.Rules;
  var U = TC.util;

  function player(state, id) {
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].id === id) return state.players[i];
    }
    return U.fail('ไม่พบผู้เล่น');
  }

  /** Move forward; the Finish space is the end of the track. */
  function move(state, id, steps) {
    if (!U.isInt(steps) || steps < 0) U.fail('จำนวนช่องไม่ถูกต้อง');
    var p = player(state, id);
    var from = p.position;
    p.position = Math.min(R.FINISH, from + steps);
    return { from: from, to: p.position, steps: p.position - from };
  }

  function maxPosition(players) {
    return players.reduce(function (m, p) { return Math.max(m, p.position); }, -1);
  }

  /** All players on the most advanced space, in seat order. */
  function leaders(players) {
    var max = maxPosition(players);
    return players.filter(function (p) { return p.position === max; }).map(function (p) { return p.id; });
  }

  function leaderSpaceType(state) {
    return R.TRACK[maxPosition(state.players)];
  }

  /** Players who reached the winning total: the Finish space, or a Speed Run target. */
  function finishers(players, goal) {
    var need = goal === undefined ? R.FINISH : goal;
    return players.filter(function (p) { return p.position >= need; }).map(function (p) { return p.id; });
  }

  TC.Movement = {
    player: player,
    move: move,
    maxPosition: maxPosition,
    leaders: leaders,
    leaderSpaceType: leaderSpaceType,
    finishers: finishers
  };
})(typeof window !== 'undefined' ? window : globalThis);
