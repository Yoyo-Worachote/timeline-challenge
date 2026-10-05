/*
 * Card Engine — draw pile, discard pile, reveal state.
 * A card id lives in exactly one place at a time: draw pile, discard pile, or on the table
 * (a Trial / Challenge). `revealed` tracks which cards have their date side visible.
 */
(function (root) {
  'use strict';
  var TC = root.TC;
  var U = TC.util;

  var byId = null;

  function index() {
    if (!byId) {
      byId = {};
      TC.CARDS.forEach(function (c) { byId[c.id] = c; });
    }
    return byId;
  }

  function get(id) {
    var card = index()[id];
    if (!card) U.fail('ไม่พบการ์ด ' + id);
    return card;
  }

  function init(state) {
    state.deck = {
      draw: U.shuffle(state, TC.CARDS.map(function (c) { return c.id; })),
      discard: []
    };
    state.revealed = {};
  }

  function draw(state, count) {
    var deck = state.deck;
    var out = [];
    for (var i = 0; i < count; i++) {
      if (deck.draw.length === 0) {
        if (deck.discard.length === 0) U.fail('การ์ดหมดกอง');
        // Reshuffle the discard pile into a new face-down draw pile.
        deck.draw = U.shuffle(state, deck.discard);
        deck.discard = [];
        deck.draw.forEach(function (id) { delete state.revealed[id]; });
        state.log.push({ kind: 'deck', text: 'กอง Draw หมด — สับกอง Discard เป็นกองใหม่' });
      }
      var id = deck.draw.pop();
      if (out.indexOf(id) !== -1) U.fail('จั่วการ์ดซ้ำ ' + id);
      out.push(id);
    }
    return out;
  }

  function reveal(state, ids) {
    ids.forEach(function (id) { state.revealed[id] = true; });
  }

  function discard(state, ids) {
    ids.forEach(function (id) {
      if (state.deck.discard.indexOf(id) !== -1 || state.deck.draw.indexOf(id) !== -1) {
        U.fail('การ์ด ' + id + ' อยู่ในกองแล้ว');
      }
      state.revealed[id] = true;
      state.deck.discard.push(id);
    });
  }

  function year(id) {
    return get(id).year;
  }

  /** What any viewer may see about a card: the year only once it has been revealed. */
  function publicCard(state, id) {
    var c = get(id);
    var shown = !!state.revealed[id];
    return {
      id: c.id, title: c.title, en: c.en, category: c.category, image: c.image,
      approx: !!c.approx, year: shown ? c.year : null, revealed: shown
    };
  }

  TC.Deck = {
    get: get,
    init: init,
    draw: draw,
    reveal: reveal,
    discard: discard,
    year: year,
    publicCard: publicCard
  };
})(typeof window !== 'undefined' ? window : globalThis);
