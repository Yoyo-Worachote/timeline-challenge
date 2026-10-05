/*
 * Timeline Challenge — shared namespace and utilities.
 * Engine files have no DOM access so they can later run on a server (Node) unchanged:
 * every file attaches to the global `TC` namespace and is loaded in order.
 */
(function (root) {
  'use strict';
  var TC = root.TC = root.TC || {};

  function RuleError(message) {
    this.name = 'RuleError';
    this.message = message;
  }
  RuleError.prototype = Object.create(Error.prototype);
  RuleError.prototype.constructor = RuleError;

  TC.util = {
    RuleError: RuleError,

    fail: function (message) {
      throw new RuleError(message);
    },

    clone: function (obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    // mulberry32 — the generator state lives inside the game state so games are
    // serializable, reproducible and identical on every client/server.
    random: function (state) {
      state.rng = (state.rng + 0x6D2B79F5) >>> 0;
      var t = state.rng;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },

    shuffle: function (state, arr) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(TC.util.random(state) * (i + 1));
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      return arr;
    },

    newSeed: function () {
      return Math.floor(Math.random() * 4294967296) >>> 0;
    },

    isInt: function (v) {
      return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
