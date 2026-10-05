/*
 * Trial Engine — validates Historical Board answers and scores the five Trials.
 * An answer is { wheels: [d0, d1, d2, d3], sign?: '+' | '-' } — exactly what a physical
 * Historical Board can express.
 */
(function (root) {
  'use strict';
  var TC = root.TC;
  var R = TC.Rules;
  var U = TC.util;

  function validateAnswer(type, answer) {
    var spec = R.TRIALS[type];
    if (!spec) U.fail('Trial ไม่ถูกต้อง');
    if (!answer || !Array.isArray(answer.wheels) || answer.wheels.length !== spec.wheels) {
      U.fail('คำตอบไม่ครบ — ต้องตั้งวงล้อครบ ' + spec.wheels + ' วง');
    }
    answer.wheels.forEach(function (w) {
      if (!U.isInt(w) || w < spec.min || w > spec.max) {
        U.fail('ค่าวงล้อต้องอยู่ระหว่าง ' + spec.min + '–' + spec.max);
      }
    });
    var clean = { wheels: answer.wheels.slice() };
    if (spec.sign) {
      if (answer.sign !== '+' && answer.sign !== '-') U.fail('ต้องตั้งวงล้อ +/−');
      clean.sign = answer.sign;
    }
    return clean;
  }

  function wheelsToNumber(wheels) {
    return wheels.reduce(function (n, d) { return n * 10 + d; }, 0);
  }

  function digitsOf(year) {
    var s = String(Math.abs(year));
    while (s.length < R.MAX_YEAR_DIGITS) s = '0' + s;
    return s.split('').map(Number);
  }

  /** Ranks (1-based) a card may take among `years`; equal dates allow every tied rank. */
  function validRanks(years, i) {
    var less = 0, equal = 0;
    years.forEach(function (y, j) {
      if (j === i) return;
      if (y < years[i]) less++;
      else if (y === years[i]) equal++;
    });
    var ranks = [];
    for (var r = less + 1; r <= less + 1 + equal; r++) ranks.push(r);
    return ranks;
  }

  function inList(list) {
    return function (w) { return list.indexOf(w) !== -1; };
  }

  /**
   * @param type    Trial id
   * @param years   card years in board order
   * @param answers { playerId: answer }
   * @returns { solution, players: { playerId: { points, correct: [bool], ... } } }
   */
  function score(type, years, answers) {
    var ids = Object.keys(answers);
    var players = {};
    var solution;

    if (type === 'T4') {
      var spaces = years.map(R.timelineSpaces);
      solution = { spaces: spaces };
      ids.forEach(function (pid) {
        var correct = answers[pid].wheels.map(function (w, i) { return spaces[i].indexOf(w) !== -1; });
        players[pid] = { correct: correct, points: count(correct) };
      });
    } else if (type === 'BET') {
      var ok = R.timelineSpaces(years[0]);
      solution = { spaces: [ok] };
      ids.forEach(function (pid) {
        var correct = answers[pid].wheels.map(inList(ok));
        players[pid] = { correct: correct, points: count(correct) };
      });
    } else if (type === 'SPLIT') {
      var distance = Math.abs(years[0] - years[1]);
      var best = Infinity;
      var guesses = {};
      ids.forEach(function (pid) {
        var guess = wheelsToNumber(answers[pid].wheels);
        guesses[pid] = { guess: guess, off: Math.abs(guess - distance) };
        best = Math.min(best, guesses[pid].off);
      });
      solution = { distance: distance, bestOff: best };
      ids.forEach(function (pid) {
        var closest = guesses[pid].off === best;
        players[pid] = {
          guess: guesses[pid].guess, off: guesses[pid].off, closest: closest,
          correct: [closest], points: closest ? R.SPLIT_REWARD : 0
        };
      });
    } else if (type === 'RD') {
      var year = years[0];
      var sign = year < 0 ? '-' : '+';
      var digits = digitsOf(year);
      solution = { sign: sign, digits: digits };
      ids.forEach(function (pid) {
        var a = answers[pid];
        var signOk = a.sign === sign;
        var digitOk = a.wheels.map(function (w, i) { return w === digits[i]; });
        players[pid] = {
          signOk: signOk, correct: digitOk,
          points: signOk ? count(digitOk) : 0
        };
      });
    } else if (type === 'COMB') {
      var ranks = years.map(function (y, i) { return validRanks(years, i); });
      solution = { ranks: ranks };
      ids.forEach(function (pid) {
        var correct = answers[pid].wheels.map(function (w, i) { return ranks[i].indexOf(w) !== -1; });
        players[pid] = { correct: correct, points: count(correct) };
      });
    } else {
      U.fail('Trial ไม่ถูกต้อง');
    }
    return { solution: solution, players: players };
  }

  function count(bools) {
    return bools.filter(Boolean).length;
  }

  TC.Trials = {
    validateAnswer: validateAnswer,
    score: score,
    validRanks: validRanks,
    wheelsToNumber: wheelsToNumber,
    digitsOf: digitsOf
  };
})(typeof window !== 'undefined' ? window : globalThis);
