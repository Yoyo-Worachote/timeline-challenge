"""Runs the browser's game engine (js/engine/*.js) unchanged inside V8, so the server and the
local game share one implementation of the rules."""
import json
import threading
from pathlib import Path

from py_mini_racer import MiniRacer

ROOT = Path(__file__).resolve().parent.parent

# Same load order as index.html / tests/index.html.
ENGINE_FILES = [
    'js/engine/core.js',
    'js/data/cards.js',
    'js/engine/rules.js',
    'js/engine/deck.js',
    'js/engine/trials.js',
    'js/engine/movement.js',
    'js/engine/challenges.js',
    'js/engine/game.js',
]

# JSON strings in and out: keeps the V8 <-> Python boundary simple and lossless.
HOST_JS = r"""
var Host = {
  createLobby: function (seed) {
    return JSON.stringify(TC.Game.createLobby(seed));
  },
  apply: function (stateJson, actionJson) {
    var r = TC.Game.applyAction(JSON.parse(stateJson), JSON.parse(actionJson));
    return JSON.stringify({ ok: r.ok, error: r.error || null, value: r.value === undefined ? null : r.value,
                            state: r.ok ? r.state : null });
  },
  view: function (stateJson) {
    return JSON.stringify(TC.Game.getView(JSON.parse(stateJson)));
  },
  rematch: function (stateJson, seed) {
    return JSON.stringify(TC.Game.rematch(JSON.parse(stateJson), seed));
  },
  restore: function (stateJson) {
    return JSON.stringify(TC.Game.restore(stateJson));
  },
  maxPlayers: function () {
    return JSON.stringify(TC.Rules.MAX_PLAYERS);
  }
};
"""


class Engine:
    """Thread-safe wrapper: a V8 context must only be used by one thread at a time."""

    def __init__(self):
        self._lock = threading.Lock()
        self._ctx = MiniRacer()
        for rel in ENGINE_FILES:
            self._ctx.eval((ROOT / rel).read_text(encoding='utf-8'))
        self._ctx.eval(HOST_JS)

    def _call(self, fn, *args):
        with self._lock:
            return json.loads(self._ctx.call(fn, *args))

    def create_lobby(self, seed):
        return self._call('Host.createLobby', seed)

    def apply(self, state, action):
        """Returns {ok, error, value, state}."""
        return self._call('Host.apply', json.dumps(state), json.dumps(action))

    def view(self, state):
        return self._call('Host.view', json.dumps(state))

    def rematch(self, state, seed):
        return self._call('Host.rematch', json.dumps(state), seed)

    def restore(self, state):
        """None if the stored state is not a valid game state."""
        return self._call('Host.restore', json.dumps(state))

    def max_players(self):
        """One person per Traveler, as defined by the engine's rules (10)."""
        return self._call('Host.maxPlayers')
