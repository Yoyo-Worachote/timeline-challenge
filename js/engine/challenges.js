/*
 * Challenge Engine — who takes part, in which order, and the Sudden Death / More or Less rounds.
 */
(function (root) {
  'use strict';
  var TC = root.TC;
  var R = TC.Rules;
  var U = TC.util;
  var Deck = TC.Deck;

  /**
   * The two players furthest behind. If several players share the last or the
   * second-to-last space, all of them take part.
   */
  function participants(players) {
    var positions = players.map(function (p) { return p.position; })
      .filter(function (v, i, a) { return a.indexOf(v) === i; })
      .sort(function (a, b) { return a - b; });
    var last = players.filter(function (p) { return p.position === positions[0]; });
    var cutoff = (last.length >= 2 || positions.length < 2) ? positions[0] : positions[1];
    // Seat order; turnOrder() decides who starts.
    return players.filter(function (p) { return p.position <= cutoff; }).map(id);
  }

  function id(p) { return p.id; }

  /**
   * Clockwise turn order. The player furthest back starts; if several are tied for last,
   * the one closest to the leading player going clockwise starts.
   */
  function turnOrder(players, participantIds, leaderId) {
    var seats = players.map(id);
    var parts = players.filter(function (p) { return participantIds.indexOf(p.id) !== -1; });
    var minPos = Math.min.apply(null, parts.map(function (p) { return p.position; }));
    var lastIds = parts.filter(function (p) { return p.position === minPos; }).map(id);

    var starter = lastIds[0];
    if (lastIds.length > 1) {
      var from = Math.max(0, seats.indexOf(leaderId));
      for (var k = 1; k <= seats.length; k++) {
        var cand = seats[(from + k) % seats.length];
        if (lastIds.indexOf(cand) !== -1) { starter = cand; break; }
      }
    }
    var order = [];
    var s = seats.indexOf(starter);
    for (var j = 0; j < seats.length; j++) {
      var pid = seats[(s + j) % seats.length];
      if (participantIds.indexOf(pid) !== -1) order.push(pid);
    }
    return order;
  }

  function create(state, type, purpose, participantIds, leaderId) {
    return {
      type: type,
      purpose: purpose, // 'LINE' (crossed a Challenge line) | 'TIEBREAK' (end-of-game tie)
      stage: 'INTRO',
      participants: participantIds.slice(),
      active: participantIds.slice(),
      eliminated: [],
      turn: 0,
      leaderId: leaderId,
      winnerId: null,
      move: null,
      sd: { timeline: [], currentCardId: null, lastPlacement: null },
      mol: { cardId: null, guesses: [] }
    };
  }

  function currentPlayer(ch) {
    return ch.stage === 'PLAY' ? ch.active[ch.turn] : null;
  }

  function begin(state, ch) {
    ch.stage = 'PLAY';
    if (ch.type === 'SUDDEN_DEATH') {
      var first = Deck.draw(state, 1)[0];
      Deck.reveal(state, [first]);
      ch.sd.timeline = [first];
      ch.sd.currentCardId = Deck.draw(state, 1)[0];
    } else {
      ch.mol.cardId = Deck.draw(state, 1)[0];
    }
  }

  /** Returns the winner id once only one player remains, otherwise null. */
  function placeCard(state, ch, playerId, slot) {
    if (ch.type !== 'SUDDEN_DEATH' || ch.stage !== 'PLAY') U.fail('ไม่ใช่ช่วงวางการ์ด Sudden Death');
    if (currentPlayer(ch) !== playerId) U.fail('ยังไม่ถึงตาของผู้เล่นนี้');
    var tl = ch.sd.timeline;
    if (!U.isInt(slot) || slot < 0 || slot > tl.length) U.fail('ตำแหน่งวางการ์ดไม่ถูกต้อง');

    var cardId = ch.sd.currentCardId;
    var y = Deck.year(cardId);
    var leftOk = slot === 0 || Deck.year(tl[slot - 1]) <= y;
    var rightOk = slot === tl.length || y <= Deck.year(tl[slot]);
    var correct = leftOk && rightOk;
    Deck.reveal(state, [cardId]);
    ch.sd.currentCardId = null;
    ch.sd.lastPlacement = { playerId: playerId, cardId: cardId, slot: slot, correct: correct };

    if (correct) {
      tl.splice(slot, 0, cardId);
      ch.turn = (ch.turn + 1) % ch.active.length;
    } else {
      Deck.discard(state, [cardId]);
      ch.active.splice(ch.turn, 1);
      ch.eliminated.push(playerId);
      ch.turn = ch.turn % ch.active.length;
    }
    if (ch.active.length === 1) return ch.active[0];
    ch.sd.currentCardId = Deck.draw(state, 1)[0];
    return null;
  }

  /** Returns the winner id on an exact guess, otherwise null. */
  function guessYear(state, ch, playerId, year) {
    if (ch.type !== 'MORE_OR_LESS' || ch.stage !== 'PLAY') U.fail('ไม่ใช่ช่วงทายปี More or Less');
    if (currentPlayer(ch) !== playerId) U.fail('ยังไม่ถึงตาของผู้เล่นนี้');
    var limit = Math.pow(10, R.MAX_YEAR_DIGITS) - 1;
    if (!U.isInt(year) || year < -limit || year > limit) U.fail('ปีต้องเป็นจำนวนเต็มระหว่าง −' + limit + ' ถึง ' + limit);
    var answer = Deck.year(ch.mol.cardId);
    var verdict = year === answer ? 'exact' : (year < answer ? 'more' : 'less');
    ch.mol.guesses.push({ playerId: playerId, year: year, verdict: verdict });
    if (verdict === 'exact') {
      Deck.reveal(state, [ch.mol.cardId]);
      return playerId;
    }
    ch.turn = (ch.turn + 1) % ch.active.length;
    return null;
  }

  /** Card ids still on the table for this Challenge. */
  function tableCards(ch) {
    var ids = ch.sd.timeline.slice();
    if (ch.sd.currentCardId) ids.push(ch.sd.currentCardId);
    if (ch.mol.cardId) ids.push(ch.mol.cardId);
    return ids;
  }

  TC.Challenges = {
    participants: participants,
    turnOrder: turnOrder,
    create: create,
    currentPlayer: currentPlayer,
    begin: begin,
    placeCard: placeCard,
    guessYear: guessYear,
    tableCards: tableCards
  };
})(typeof window !== 'undefined' ? window : globalThis);
