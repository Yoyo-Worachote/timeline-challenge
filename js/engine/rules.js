/*
 * Rule constants — taken from the official Timeline Challenge rulebook (see RULES.md).
 * Everything numeric about the game lives here.
 */
(function (root) {
  'use strict';
  var TC = root.TC;

  // The Timeline section of the board: nine dates, spaces 0-9 around them.
  var TIMELINE_DATES = [-500, 850, 1300, 1600, 1750, 1820, 1880, 1930, 1970];

  var TRIALS = {
    T4: {
      id: 'T4', name: 'Timeline 4', color: 'green', cards: 4,
      wheels: 4, min: 0, max: 9, sign: false,
      short: 'หาช่องบน Timeline ของการ์ด 4 ใบ',
      help: 'ตั้งวงล้อแต่ละวงเป็นเลขช่อง (0–9) บน Timeline ของการ์ดใบที่ตรงกัน — ถูก 1 ใบ เดิน 1 ช่อง'
    },
    BET: {
      id: 'BET', name: 'The Bet', color: 'red', cards: 1,
      wheels: 4, min: 0, max: 9, sign: false,
      short: 'เดิมพันช่องบน Timeline ของการ์ด 1 ใบ',
      help: 'ตั้งวงล้อทั้ง 4 วงเป็นเลขช่อง (0–9) ของการ์ดใบเดียว — ตอบต่างกันเพื่อกระจายความเสี่ยง หรือตอบซ้ำเพื่อคะแนนมากขึ้น วงที่ถูก 1 วง เดิน 1 ช่อง'
    },
    SPLIT: {
      id: 'SPLIT', name: 'The Split', color: 'blue', cards: 2,
      wheels: 4, min: 0, max: 9, sign: false,
      short: 'ประมาณจำนวนปีระหว่างการ์ด 2 ใบ',
      help: 'ตั้งวงล้อเป็นจำนวนปีระหว่างการ์ดสองใบ (0000–9999) — คนที่ใกล้ที่สุดเดิน 4 ช่อง ถ้าเสมอกันเดินทุกคน'
    },
    RD: {
      id: 'RD', name: 'The Right Date', color: 'yellow', cards: 1,
      wheels: 4, min: 0, max: 9, sign: true,
      short: 'ทายปีที่แน่นอนของการ์ด 1 ใบ',
      help: 'ตั้งวงล้อ +/− และตัวเลข 4 หลักเป็นปีของการ์ด — ถูก 1 หลัก เดิน 1 ช่อง แต่ถ้าเครื่องหมาย +/− ผิด ได้ 0 ทั้งหมด'
    },
    COMB: {
      id: 'COMB', name: 'The Combination', color: 'purple', cards: 4,
      wheels: 4, min: 1, max: 4, sign: false,
      short: 'เรียงลำดับเวลาการ์ด 4 ใบ',
      help: 'ตั้งวงล้อแต่ละวงเป็นลำดับ (1 = เก่าที่สุด … 4 = ใหม่ที่สุด) ของการ์ดใบที่ตรงกัน — ถูก 1 ใบ เดิน 1 ช่อง'
    }
  };

  // The Clock, read from the board illustration in the rulebook: Start (A) -> spiral -> Finish (B).
  var TRACK = [
    'T4',    // 0  Start
    'RD', 'BET', 'COMB', 'SPLIT', 'RD', 'T4',            // 1-6
    'SPLIT', 'BET', 'SPLIT', 'COMB', 'RD', 'T4', 'COMB', // 7-13
    'RD', 'BET', 'COMB', 'RD', 'BET', 'SPLIT', 'T4',     // 14-20
    'FINISH' // 21
  ];
  var START = 0;
  var FINISH = TRACK.length - 1;

  // A Challenge line sits between space `afterSpace` and `afterSpace + 1`.
  var CHALLENGES = {
    SUDDEN_DEATH: {
      id: 'SUDDEN_DEATH', name: 'Sudden Death', afterSpace: 6,
      help: 'เปิดการ์ด 1 ใบให้เห็นปี แต่ละคนผลัดกันจั่วการ์ดแล้ววางลงใน timeline — วางผิดตกรอบ เหลือคนสุดท้ายชนะ เดิน 3 ช่อง'
    },
    MORE_OR_LESS: {
      id: 'MORE_OR_LESS', name: 'More or Less', afterSpace: 13,
      help: 'ผู้นำเป็นกรรมการ อ่านชื่อการ์ด ผู้เข้าร่วมผลัดกันทายปี กรรมการตอบ "มากกว่า" หรือ "น้อยกว่า" — ใครทายถูกตรงปีชนะ เดิน 3 ช่อง'
    }
  };
  var CHALLENGE_ORDER = ['SUDDEN_DEATH', 'MORE_OR_LESS'];

  var TOKENS = [
    { id: 'biplane', name: 'เครื่องบินปีกสองชั้น', icon: '✈️', color: '#e8b04a' },
    { id: 'locomotive', name: 'รถจักรไอน้ำ', icon: '🚂', color: '#e5534b' },
    { id: 'car', name: 'รถยนต์', icon: '🚗', color: '#4aa3e8' },
    { id: 'ship', name: 'เรือใบ', icon: '⛵', color: '#4cc38a' },
    { id: 'shuttle', name: 'กระสวยอวกาศ', icon: '🚀', color: '#b07ce8' }
  ];

  /**
   * Which Timeline spaces (0-9) are correct for a year.
   * A year exactly on a board date is accepted on both sides of that date.
   */
  function timelineSpaces(year) {
    var spaces = [];
    for (var k = 0; k <= TIMELINE_DATES.length; k++) {
      var lo = k === 0 ? -Infinity : TIMELINE_DATES[k - 1];
      var hi = k === TIMELINE_DATES.length ? Infinity : TIMELINE_DATES[k];
      if (year >= lo && year <= hi) spaces.push(k);
    }
    return spaces;
  }

  function spaceRangeLabel(k) {
    if (k === 0) return 'ก่อน ' + TIMELINE_DATES[0];
    if (k === TIMELINE_DATES.length) return 'หลัง ' + TIMELINE_DATES[TIMELINE_DATES.length - 1];
    return TIMELINE_DATES[k - 1] + ' – ' + TIMELINE_DATES[k];
  }

  function formatYear(year) {
    if (year === null || year === undefined) return '????';
    return year < 0 ? '−' + Math.abs(year) : String(year);
  }

  TC.Rules = {
    TIMELINE_DATES: TIMELINE_DATES,
    TRIALS: TRIALS,
    TRACK: TRACK,
    START: START,
    FINISH: FINISH,
    CHALLENGES: CHALLENGES,
    CHALLENGE_ORDER: CHALLENGE_ORDER,
    CHALLENGE_REWARD: 3,
    SPLIT_REWARD: 4,
    FIRST_TRIAL: 'T4',
    MIN_PLAYERS: 2,
    MAX_PLAYERS: 5,
    MAX_NAME_LENGTH: 24,
    MAX_YEAR_DIGITS: 4,
    TOKENS: TOKENS,
    timelineSpaces: timelineSpaces,
    spaceRangeLabel: spaceRangeLabel,
    formatYear: formatYear
  };
})(typeof window !== 'undefined' ? window : globalThis);
