/*
 * Game Engine — the authoritative state machine.
 *
 *   LOBBY ─START_GAME─▶ TRIAL_INPUT ─(all answers locked)─▶ TRIAL_RESULT ─CONTINUE─▶
 *       ├─ someone on Finish ──▶ GAME_OVER  (or TIEBREAK_CHOICE when several arrive together)
 *       ├─ leader crossed an unplayed Challenge line ──▶ CHALLENGE (INTRO ▶ PLAY ▶ RESULT) ─CONTINUE─▶ (same checks)
 *       └─ otherwise ──▶ TRIAL_INPUT for the Trial on the leader's space
 *
 * applyAction(state, action) never mutates its input and returns { ok, state, error }.
 * State is plain JSON, so it can be persisted, sent over the network, or run on a server.
 * UIs must render getView(state): it hides card dates and other players' answers.
 */
(function (root) {
  'use strict';
  var TC = root.TC;
  var R = TC.Rules;
  var U = TC.util;
  var Deck = TC.Deck;
  var Trials = TC.Trials;
  var Move = TC.Movement;
  var Ch = TC.Challenges;

  var PHASE = {
    LOBBY: 'LOBBY',
    TRIAL_INPUT: 'TRIAL_INPUT',
    TRIAL_RESULT: 'TRIAL_RESULT',
    CHALLENGE: 'CHALLENGE',
    TIEBREAK_CHOICE: 'TIEBREAK_CHOICE',
    GAME_OVER: 'GAME_OVER'
  };

  var VERSION = 1;

  function createLobby(seed) {
    return {
      version: VERSION,
      seq: 0,
      rng: (seed === undefined ? U.newSeed() : seed) >>> 0,
      phase: PHASE.LOBBY,
      nextPlayerNo: 1,
      players: [],
      deck: { draw: [], discard: [] },
      revealed: {},
      trialCount: 0,
      trial: null,
      challenge: null,
      challengesPlayed: {},
      tie: null,
      winners: [],
      lastMoves: null,
      log: []
    };
  }

  /** A new lobby with the same Travelers (for "play again"). */
  function rematch(state, seed) {
    var s = createLobby(seed);
    state.players.forEach(function (p) {
      s.players.push({ id: p.id, name: p.name, token: p.token, members: p.members, ready: false, position: R.START });
    });
    s.nextPlayerNo = state.nextPlayerNo;
    return s;
  }

  // ---------------------------------------------------------------- helpers

  function requirePhase(s) {
    var ok = Array.prototype.slice.call(arguments, 1);
    if (ok.indexOf(s.phase) === -1) U.fail('ทำไม่ได้ในขั้นตอนนี้ของเกม');
  }

  function log(s, kind, text) {
    s.log.push({ kind: kind, text: text });
    if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
  }

  function name(s, pid) {
    return Move.player(s, pid).name;
  }

  function token(id) {
    for (var i = 0; i < R.TOKENS.length; i++) if (R.TOKENS[i].id === id) return R.TOKENS[i];
    return null;
  }

  // ---------------------------------------------------------------- lobby

  function addPlayer(s, a) {
    requirePhase(s, PHASE.LOBBY);
    if (s.players.length >= R.MAX_PLAYERS) U.fail('ผู้เล่นได้สูงสุด ' + R.MAX_PLAYERS + ' Traveler (เล่นเป็นทีมได้)');
    var nm = String(a.name || '').trim();
    if (!nm) U.fail('กรุณาใส่ชื่อ');
    if (nm.length > R.MAX_NAME_LENGTH) U.fail('ชื่อยาวเกิน ' + R.MAX_NAME_LENGTH + ' ตัวอักษร');
    if (s.players.some(function (p) { return p.name.toLowerCase() === nm.toLowerCase(); })) U.fail('ชื่อนี้ถูกใช้แล้ว');
    if (!token(a.token)) U.fail('กรุณาเลือก Traveler token');
    if (s.players.some(function (p) { return p.token === a.token; })) U.fail('Token นี้ถูกเลือกแล้ว');
    var members = String(a.members || '').trim().slice(0, 80);
    var id = 'p' + s.nextPlayerNo++;
    s.players.push({ id: id, name: nm, token: a.token, members: members, ready: false, position: R.START });
    return id;
  }

  function removePlayer(s, a) {
    requirePhase(s, PHASE.LOBBY);
    Move.player(s, a.playerId);
    s.players = s.players.filter(function (p) { return p.id !== a.playerId; });
  }

  function setReady(s, a) {
    requirePhase(s, PHASE.LOBBY);
    Move.player(s, a.playerId).ready = !!a.ready;
  }

  function startGame(s) {
    requirePhase(s, PHASE.LOBBY);
    if (s.players.length < R.MIN_PLAYERS) U.fail('ต้องมีผู้เล่นอย่างน้อย ' + R.MIN_PLAYERS + ' คน');
    if (s.players.some(function (p) { return !p.ready; })) U.fail('ผู้เล่นทุกคนต้องกด "พร้อม" ก่อน');
    s.players.forEach(function (p) { p.position = R.START; });
    Deck.init(s);
    s.challengesPlayed = {};
    R.CHALLENGE_ORDER.forEach(function (c) { s.challengesPlayed[c] = false; });
    log(s, 'game', 'เริ่มเกม! ทุก Traveler อยู่ที่ช่อง Start — Trial แรกคือ Timeline 4');
    startTrial(s, R.FIRST_TRIAL);
  }

  // ---------------------------------------------------------------- trials

  function startTrial(s, type) {
    var spec = R.TRIALS[type];
    if (!spec) U.fail('Trial ไม่ถูกต้อง: ' + type);
    s.trialCount++;
    s.trial = {
      no: s.trialCount,
      type: type,
      cardIds: Deck.draw(s, spec.cards),
      answers: {},
      result: null
    };
    s.phase = PHASE.TRIAL_INPUT;
    s.lastMoves = null;
    log(s, 'trial', 'Trial #' + s.trialCount + ': ' + spec.name);
  }

  function submitAnswer(s, a) {
    requirePhase(s, PHASE.TRIAL_INPUT);
    var p = Move.player(s, a.playerId);
    if (s.trial.answers[p.id]) U.fail(p.name + ' ล็อกคำตอบไปแล้ว');
    s.trial.answers[p.id] = Trials.validateAnswer(s.trial.type, a.answer);
    log(s, 'answer', p.name + ' ล็อกคำตอบแล้ว');
    if (Object.keys(s.trial.answers).length === s.players.length) resolveTrial(s);
  }

  function resolveTrial(s) {
    var t = s.trial;
    Deck.reveal(s, t.cardIds);
    var years = t.cardIds.map(Deck.year);
    t.result = Trials.score(t.type, years, t.answers);
    s.lastMoves = {};
    s.players.forEach(function (p) {
      var pts = t.result.players[p.id].points;
      s.lastMoves[p.id] = Move.move(s, p.id, pts);
    });
    s.phase = PHASE.TRIAL_RESULT;
    log(s, 'reveal', 'เปิดเฉลย ' + R.TRIALS[t.type].name + ': ' + s.players.map(function (p) {
      return p.name + ' +' + s.lastMoves[p.id].steps;
    }).join(', '));
  }

  function finishTrial(s) {
    Deck.discard(s, s.trial.cardIds);
    s.trial = null;
    afterMovement(s);
  }

  // ---------------------------------------------------------------- flow

  /** Win check first (the game ends at once), then Challenge lines, then the next Trial. */
  function afterMovement(s) {
    var done = Move.finishers(s.players);
    if (done.length === 1) return gameOver(s, done);
    if (done.length > 1) {
      s.tie = { playerIds: done };
      s.phase = PHASE.TIEBREAK_CHOICE;
      log(s, 'game', done.map(function (pid) { return name(s, pid); }).join(', ') + ' ถึง Finish พร้อมกัน!');
      return;
    }

    var lead = Move.maxPosition(s.players);
    for (var i = 0; i < R.CHALLENGE_ORDER.length; i++) {
      var cid = R.CHALLENGE_ORDER[i];
      if (s.challengesPlayed[cid] || lead <= R.CHALLENGES[cid].afterSpace) continue;
      s.challengesPlayed[cid] = true;
      if (cid === 'MORE_OR_LESS' && s.players.length === 2) {
        log(s, 'challenge', 'ข้ามเส้น More or Less — ไม่เล่นในเกม 2 ผู้เล่น');
        continue;
      }
      var leaderId = Move.leaders(s.players)[0];
      var parts = Ch.participants(s.players);
      startChallenge(s, cid, 'LINE', Ch.turnOrder(s.players, parts, leaderId), leaderId);
      return;
    }
    startTrial(s, Move.leaderSpaceType(s));
  }

  function gameOver(s, winners) {
    s.winners = winners.slice();
    s.phase = PHASE.GAME_OVER;
    log(s, 'game', 'จบเกม — ผู้ชนะ: ' + winners.map(function (pid) { return name(s, pid); }).join(', '));
  }

  // ---------------------------------------------------------------- challenges

  function startChallenge(s, type, purpose, order, leaderId) {
    s.challenge = Ch.create(s, type, purpose, order, leaderId);
    s.phase = PHASE.CHALLENGE;
    s.lastMoves = null;
    log(s, 'challenge', (purpose === 'TIEBREAK' ? 'ไทเบรก ' : 'Challenge ') + R.CHALLENGES[type].name + ': ' +
      order.map(function (pid) { return name(s, pid); }).join(' → '));
  }

  function beginChallenge(s) {
    requirePhase(s, PHASE.CHALLENGE);
    if (s.challenge.stage !== 'INTRO') U.fail('Challenge เริ่มไปแล้ว');
    Ch.begin(s, s.challenge);
  }

  function sdPlace(s, a) {
    requirePhase(s, PHASE.CHALLENGE);
    var ch = s.challenge;
    var winner = Ch.placeCard(s, ch, a.playerId, a.slot);
    var lp = ch.sd.lastPlacement;
    log(s, 'challenge', name(s, a.playerId) + (lp.correct ? ' วางถูก' : ' วางผิด — ตกรอบ'));
    if (winner) finishChallenge(s, winner);
  }

  function molGuess(s, a) {
    requirePhase(s, PHASE.CHALLENGE);
    var ch = s.challenge;
    var winner = Ch.guessYear(s, ch, a.playerId, a.year);
    var g = ch.mol.guesses[ch.mol.guesses.length - 1];
    log(s, 'challenge', name(s, a.playerId) + ' ทาย ' + R.formatYear(a.year) + ' → ' +
      ({ more: 'มากกว่า', less: 'น้อยกว่า', exact: 'ถูกต้อง!' })[g.verdict]);
    if (winner) finishChallenge(s, winner);
  }

  function finishChallenge(s, winnerId) {
    var ch = s.challenge;
    ch.stage = 'RESULT';
    ch.winnerId = winnerId;
    if (ch.purpose === 'TIEBREAK') {
      log(s, 'challenge', name(s, winnerId) + ' ชนะไทเบรก');
      return;
    }
    var steps = R.CHALLENGE_REWARD;
    // Two-player Sudden Death: only the player behind can score; a leader's win only blocks.
    if (s.players.length === 2 && ch.type === 'SUDDEN_DEATH') {
      var me = Move.player(s, winnerId);
      var other = s.players[0].id === winnerId ? s.players[1] : s.players[0];
      if (me.position > other.position) steps = 0;
    }
    ch.move = Move.move(s, winnerId, steps);
    s.lastMoves = {};
    s.lastMoves[winnerId] = ch.move;
    log(s, 'challenge', name(s, winnerId) + ' ชนะ ' + R.CHALLENGES[ch.type].name +
      (steps ? ' เดิน ' + ch.move.steps + ' ช่อง' : ' (ผู้นำชนะ — ป้องกันไม่ให้อีกฝ่ายเดิน)'));
  }

  function closeChallenge(s) {
    var ch = s.challenge;
    if (ch.stage !== 'RESULT') U.fail('Challenge ยังไม่จบ');
    var leftovers = Ch.tableCards(ch);
    Deck.discard(s, leftovers);
    s.challenge = null;
    if (ch.purpose === 'TIEBREAK') return gameOver(s, [ch.winnerId]);
    afterMovement(s);
  }

  function resolveTie(s, a) {
    requirePhase(s, PHASE.TIEBREAK_CHOICE);
    var ids = s.tie.playerIds;
    s.tie = null;
    if (a.mode === 'SHARE') return gameOver(s, ids);
    if (a.mode === 'SUDDEN_DEATH') {
      // Everyone is on Finish, so nobody is "furthest back": play in seat order.
      return startChallenge(s, 'SUDDEN_DEATH', 'TIEBREAK', ids, ids[0]);
    }
    U.fail('ตัวเลือกไม่ถูกต้อง');
  }

  function doContinue(s) {
    if (s.phase === PHASE.TRIAL_RESULT) return finishTrial(s);
    if (s.phase === PHASE.CHALLENGE) return closeChallenge(s);
    U.fail('ยังไปต่อไม่ได้');
  }

  // ---------------------------------------------------------------- dispatch

  var HANDLERS = {
    ADD_PLAYER: addPlayer,
    REMOVE_PLAYER: removePlayer,
    SET_READY: setReady,
    START_GAME: startGame,
    SUBMIT_ANSWER: submitAnswer,
    CONTINUE: doContinue,
    CHALLENGE_BEGIN: beginChallenge,
    SD_PLACE: sdPlace,
    MOL_GUESS: molGuess,
    RESOLVE_TIE: resolveTie
  };

  /**
   * @param action { type, ...payload, seq? } — when `seq` is given it must match state.seq,
   *               which rejects stale/duplicate submissions (double clicks, network retries).
   */
  function applyAction(state, action) {
    try {
      if (!action || !HANDLERS[action.type]) U.fail('คำสั่งไม่ถูกต้อง');
      if (action.seq !== undefined && action.seq !== state.seq) U.fail('สถานะเกมเปลี่ยนไปแล้ว — กรุณาลองใหม่');
      var s = U.clone(state);
      var value = HANDLERS[action.type](s, action);
      s.seq++;
      return { ok: true, state: s, value: value };
    } catch (e) {
      if (e instanceof U.RuleError) return { ok: false, state: state, error: e.message };
      throw e;
    }
  }

  // ---------------------------------------------------------------- views

  /** Who may act right now, for UIs and servers. */
  function pendingActors(state) {
    if (state.phase === PHASE.TRIAL_INPUT) {
      return state.players.filter(function (p) { return !state.trial.answers[p.id]; }).map(function (p) { return p.id; });
    }
    if (state.phase === PHASE.CHALLENGE) {
      var cur = Ch.currentPlayer(state.challenge);
      return cur ? [cur] : [];
    }
    return [];
  }

  /**
   * Everything a client may see. Card dates appear only once revealed by the rules,
   * locked answers stay secret until the reveal, and the draw-pile order is never sent.
   */
  function getView(state) {
    var v = U.clone(state);
    delete v.rng;
    v.deck = { drawCount: state.deck.draw.length, discardCount: state.deck.discard.length };
    delete v.revealed;

    var ids = [];
    if (state.trial) ids = ids.concat(state.trial.cardIds);
    if (state.challenge) ids = ids.concat(Ch.tableCards(state.challenge));
    if (state.challenge && state.challenge.sd.lastPlacement) ids.push(state.challenge.sd.lastPlacement.cardId);
    v.cards = {};
    ids.forEach(function (cid) { v.cards[cid] = Deck.publicCard(state, cid); });

    if (state.phase === PHASE.TRIAL_INPUT) {
      var locked = {};
      Object.keys(state.trial.answers).forEach(function (pid) { locked[pid] = true; });
      v.trial.answers = locked;
    }
    v.pendingActors = pendingActors(state);
    v.leaders = state.players.length ? Move.leaders(state.players) : [];
    v.nextTrialType = state.players.length ? Move.leaderSpaceType(state) : null;
    return v;
  }

  /** Accept a persisted state only if it looks like one of ours. */
  function restore(json) {
    try {
      var s = typeof json === 'string' ? JSON.parse(json) : json;
      if (!s || s.version !== VERSION || !PHASE[s.phase] || !Array.isArray(s.players)) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  TC.Game = {
    PHASE: PHASE,
    createLobby: createLobby,
    rematch: rematch,
    applyAction: applyAction,
    getView: getView,
    pendingActors: pendingActors,
    restore: restore
  };
})(typeof window !== 'undefined' ? window : globalThis);
