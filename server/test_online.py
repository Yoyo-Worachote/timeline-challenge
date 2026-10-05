"""
End-to-end test of the online server: starts server.py as a real process and drives several
independent clients over HTTP + Server-Sent Events, like separate browsers would.

Run:  .venv/Scripts/python server/test_online.py      (exit code 0 = all passed)

The test uses js/data/cards.js as an answer oracle to play well-formed games; real clients never
receive card dates before the rules reveal them (checked on every frame below).
"""
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get('TEST_PORT', '8799'))
YEARS = {}
results = []


def load_years():
    src = (ROOT / 'js' / 'data' / 'cards.js').read_text(encoding='utf-8')
    rows = re.findall(r"\n\s*\['[^\n]*?',\s*(?:'|\")[^\n]*?(?:'|\"),\s*(-?\d+),", src)
    for i, year in enumerate(rows):
        YEARS['c%03d' % (i + 1)] = int(year)


# ------------------------------------------------------------------ http helpers

def request(method, path, body=None):
    conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=10)
    data = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, data, {'Content-Type': 'application/json'})
    res = conn.getresponse()
    payload = json.loads(res.read() or b'{}')
    conn.close()
    return payload


class Client:
    """One 'browser': an identity plus a live SSE stream."""

    def __init__(self, name):
        self.name = name
        self.code = self.token = None
        self.view = None
        self.frames = 0
        self.cond = threading.Condition()
        self.conn = None
        self.privacy_errors = []

    def create(self):
        r = request('POST', '/api/rooms', {'name': self.name})
        assert r['ok'], r
        self.code, self.token = r['code'], r['token']
        return self

    def join(self, code, token=None):
        r = request('POST', '/api/rooms/%s/join' % code, {'name': self.name, 'token': token})
        if r['ok']:
            self.code, self.token = r['code'], r['token']
        return r

    def connect(self):
        self.conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=60)
        self.conn.request('GET', '/api/rooms/%s/stream?token=%s' % (self.code, self.token))
        self.sock = self.conn.sock          # http.client forgets it once the response starts
        res = self.conn.getresponse()
        assert res.status == 200, res.status
        threading.Thread(target=self._read, args=(res,), daemon=True).start()
        return self

    def close(self):
        try:
            self.sock.shutdown(2)
            self.sock.close()
        except Exception:
            pass
        self.conn.close()

    def _read(self, res):
        try:
            while True:
                line = res.fp.readline()
                if not line:
                    return
                if line.startswith(b'data: '):
                    view = json.loads(line[6:])
                    self.check_privacy(view)
                    with self.cond:
                        self.view = view
                        self.frames += 1
                        self.cond.notify_all()
        except Exception:
            return

    def check_privacy(self, v):
        if v['phase'] == 'TRIAL_INPUT':
            for pid, a in v['trial']['answers'].items():
                if a is not True:
                    self.privacy_errors.append('answer of %s visible before reveal' % pid)
        for cid, card in v.get('cards', {}).items():
            if not card['revealed'] and card['year'] is not None:
                self.privacy_errors.append('year of %s visible before reveal' % cid)
        for forbidden in ('rng',):
            if forbidden in v:
                self.privacy_errors.append('%s leaked' % forbidden)
        if 'draw' in v.get('deck', {}):
            self.privacy_errors.append('draw pile order leaked')

    def wait(self, pred, timeout=10):
        end = time.time() + timeout
        with self.cond:
            while not (self.view and pred(self.view)):
                left = end - time.time()
                if left <= 0:
                    raise AssertionError('%s: timed out waiting; phase=%s' % (self.name, self.view and self.view['phase']))
                self.cond.wait(left)
            return self.view

    def act(self, action, expect_ok=True):
        # No automatic `seq`: several test clients act back-to-back, and the stale-seq guard
        # is exercised explicitly in the answers test.
        r = request('POST', '/api/rooms/%s/action' % self.code, {'token': self.token, 'action': action})
        if expect_ok and not r['ok']:
            raise AssertionError('%s %s rejected: %s' % (self.name, action['type'], r.get('error')))
        if not expect_ok and r['ok']:
            raise AssertionError('%s %s should have been rejected' % (self.name, action['type']))
        return r

    @property
    def me(self):
        return self.view['room']['me']


def test(name, fn):
    try:
        fn()
        results.append((name, True, ''))
        print('PASS', name, flush=True)
    except Exception as exc:
        results.append((name, False, repr(exc)))
        print('FAIL', name, '-', exc, flush=True)


# ------------------------------------------------------------------ answer oracle (test only)

def digits(n):
    return [int(c) for c in str(abs(n)).zfill(4)]


def space(year):
    dates = [-500, 850, 1300, 1600, 1750, 1820, 1880, 1930, 1970]
    return sum(1 for d in dates if year > d)


def perfect(view):
    t = view['trial']
    ys = [YEARS[c] for c in t['cardIds']]
    kind = t['type']
    if kind == 'T4':
        return {'wheels': [space(y) for y in ys]}
    if kind == 'BET':
        return {'wheels': [space(ys[0])] * 4}
    if kind == 'SPLIT':
        return {'wheels': digits(abs(ys[0] - ys[1]))}
    if kind == 'RD':
        return {'sign': '-' if ys[0] < 0 else '+', 'wheels': digits(ys[0])}
    return {'wheels': [1 + sum(1 for o in ys if o < y) for y in ys]}


def blank(view):
    """An answer worth 0 (except The Split, where the closest guess always scores)."""
    t = view['trial']
    ys = [YEARS[c] for c in t['cardIds']]
    kind = t['type']
    if kind == 'T4':
        return {'wheels': [(space(y) + 5) % 10 for y in ys]}
    if kind == 'BET':
        return {'wheels': [(space(ys[0]) + 5) % 10] * 4}
    if kind == 'SPLIT':
        return {'wheels': [9, 9, 9, 9]}
    if kind == 'RD':
        return {'sign': '+' if ys[0] < 0 else '-', 'wheels': [0, 0, 0, 0]}
    ranks = [1 + sum(1 for o in ys if o < y) for y in ys]
    return {'wheels': [r % 4 + 1 for r in ranks]}


# ------------------------------------------------------------------ scenario

def start_server(data_file):
    env = dict(os.environ, PORT=str(PORT), HOST='127.0.0.1', TC_DATA=data_file, TC_QUIET='1')
    log = open(data_file + '.log', 'a')
    proc = subprocess.Popen([sys.executable, str(ROOT / 'server' / 'server.py')], env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            if request('GET', '/api/health')['ok']:
                return proc
        except OSError:
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError('server did not start')


def main():
    load_years()
    data_file = os.path.join(tempfile.mkdtemp(), 'rooms.json')
    proc = start_server(data_file)
    A, B, C = Client('Alice'), Client('Bob'), Client('Cara')
    state = {}

    def create_and_join():
        A.create().connect()
        assert re.fullmatch(r'[A-Z2-9]{5}', A.code)
        assert B.join(A.code.lower())['ok'], 'join is case-insensitive'
        B.connect()
        A.wait(lambda v: len(v['room']['members']) == 2)
        B.wait(lambda v: v['room']['code'] == A.code and not v['room']['isHost'])
        assert A.view['room']['isHost']
        assert not B.join('ZZZZZ')['ok'], 'unknown room rejected'
    test('Create room -> join by code from a second client', create_and_join)

    def lobby():
        A.act({'type': 'ADD_PLAYER', 'name': 'ทีม A', 'token': 'car'})
        A.wait(lambda v: v['room']['me'])
        B.act({'type': 'ADD_PLAYER', 'name': 'ทีม B', 'token': 'ship'})
        B.wait(lambda v: v['room']['me'] and len(v['players']) == 2)
        A.wait(lambda v: len(v['players']) == 2)
        B.act({'type': 'ADD_PLAYER', 'name': 'again', 'token': 'shuttle'}, expect_ok=False)
        B.act({'type': 'SET_READY', 'playerId': A.me, 'ready': True}, expect_ok=False)   # not your Traveler
        for c in (A, B):
            c.act({'type': 'SET_READY', 'playerId': c.me, 'ready': True})
        A.wait(lambda v: all(p['ready'] for p in v['players']))
        B.act({'type': 'START_GAME'}, expect_ok=False)                                   # host only
        A.act({'type': 'START_GAME'})
        for c in (A, B):
            c.wait(lambda v: v['phase'] == 'TRIAL_INPUT' and v['trial']['type'] == 'T4')
        assert A.view['trial']['cardIds'] == B.view['trial']['cardIds'], 'same cards on both clients'
    test('Lobby: own Traveler only, host-only start, both clients enter Trial 1', lobby)

    def spectator():
        assert C.join(A.code)['ok']
        C.connect().wait(lambda v: v['phase'] == 'TRIAL_INPUT')
        assert C.view['room']['me'] is None
        C.act({'type': 'CONTINUE'}, expect_ok=False)
        C.act({'type': 'ADD_PLAYER', 'name': 'late', 'token': 'shuttle'}, expect_ok=False)  # game already started
    test('Late joiner is a spectator and cannot act', spectator)

    def answers():
        seq = A.view['seq']
        A.act({'type': 'SUBMIT_ANSWER', 'playerId': A.me, 'answer': perfect(A.view)})
        B.wait(lambda v: v['seq'] > seq and v['trial']['answers'].get(A.me) is True)
        assert B.view['phase'] == 'TRIAL_INPUT', 'no reveal until everyone answered'
        A.act({'type': 'SUBMIT_ANSWER', 'playerId': A.me, 'answer': perfect(A.view)}, expect_ok=False)  # double submit
        B.act({'type': 'SUBMIT_ANSWER', 'playerId': A.me, 'answer': blank(B.view)}, expect_ok=False)    # impersonation
        B.act({'type': 'SUBMIT_ANSWER', 'playerId': B.me, 'answer': {'wheels': [1, 2]}}, expect_ok=False)  # invalid
        stale = dict(type='SUBMIT_ANSWER', playerId=B.me, answer=blank(B.view), seq=seq)
        B.act(stale, expect_ok=False)                                                        # stale seq
        B.act({'type': 'SUBMIT_ANSWER', 'playerId': B.me, 'answer': blank(B.view)})
        va = A.wait(lambda v: v['phase'] == 'TRIAL_RESULT')
        vb = B.wait(lambda v: v['phase'] == 'TRIAL_RESULT')
        assert va['seq'] == vb['seq']
        assert va['players'] == vb['players'], 'same positions everywhere'
        assert va['trial']['answers'] == vb['trial']['answers'], 'answers revealed to everyone together'
        pos = {p['id']: p['position'] for p in va['players']}
        assert pos[A.me] == 4 and pos[B.me] == 0, pos
        assert all(va['cards'][c]['year'] is not None for c in va['trial']['cardIds'])
        state['after_t1'] = va['seq']
    test('Answer -> private until all lock -> reveal + movement identical on both clients', answers)

    def next_trial():
        B.act({'type': 'CONTINUE'})
        for c in (A, B, C):
            c.wait(lambda v: v['phase'] == 'TRIAL_INPUT' and v['trial']['no'] == 2)
        assert A.view['trial']['type'] == 'SPLIT', 'leader on space 4 -> The Split'
    test('Continue -> next Trial chosen by leader, synced to all clients', next_trial)

    def reconnect():
        A.close()
        # A dropped connection is noticed on the server's next write (keep-alive ping every 15 s).
        B.wait(lambda v: not [m for m in v['room']['members'] if m['name'] == 'Alice'][0]['online'], timeout=25)
        old_token, old_me = A.token, B.view['players'][0]['id']
        r = A.join(A.code, token=old_token)
        assert r['ok'] and r['token'] == old_token
        A.view = None
        A.connect().wait(lambda v: v['room']['me'] == old_me and v['trial']['no'] == 2)
        B.wait(lambda v: [m for m in v['room']['members'] if m['name'] == 'Alice'][0]['online'])
    test('Disconnect + reconnect with the same identity returns to the same seat', reconnect)

    def restart():
        nonlocal proc
        for c in (A, B, C):
            c.close()
        time.sleep(2.5)        # let the server flush rooms.json
        proc.terminate()
        proc.wait(10)
        proc = start_server(data_file)
        for c in (A, B):
            assert c.join(c.code, token=c.token)['ok'], 'room survives a server restart'
            c.view = None
            c.connect().wait(lambda v: v['phase'] == 'TRIAL_INPUT' and v['trial']['no'] == 2)
        assert A.me and B.me and A.me != B.me
    test('Server restart keeps the room; clients reconnect', restart)

    def full_game():
        """Play to Game Over over the network, exercising Sudden Death and More or Less (3 Travelers)."""
        D = Client('Dan')
        room_host = Client('Host').create().connect()
        E = Client('Eve')
        assert D.join(room_host.code)['ok'] and E.join(room_host.code)['ok']
        D.connect(); E.connect()
        players = [room_host, D, E]
        for i, c in enumerate(players):
            c.wait(lambda v: v['phase'] == 'LOBBY')
            c.act({'type': 'ADD_PLAYER', 'name': c.name, 'token': ['car', 'ship', 'biplane'][i]})
            c.wait(lambda v: v['room']['me'])
        for c in players:
            c.act({'type': 'SET_READY', 'playerId': c.me, 'ready': True})
        room_host.wait(lambda v: len(v['players']) == 3 and all(p['ready'] for p in v['players']))
        room_host.act({'type': 'START_GAME'})
        seen = set()
        turn = 0
        for _ in range(400):
            v = room_host.wait(lambda v: v['phase'] != 'LOBBY')
            # every client must converge on the same state
            for c in players:
                c.wait(lambda x, s=v['seq']: x['seq'] >= s)
            ph = v['phase']
            if ph == 'GAME_OVER':
                break
            if ph == 'TRIAL_INPUT':
                turn += 1
                for i, c in enumerate(players):
                    if v['trial']['answers'].get(c.me):
                        continue
                    good = (turn + i) % 3 != 0 or i == 2       # player E plays perfectly, others mostly
                    c.act({'type': 'SUBMIT_ANSWER', 'playerId': c.me,
                           'answer': perfect(c.view) if good else blank(c.view)}, expect_ok=True)
                room_host.wait(lambda x: x['phase'] != 'TRIAL_INPUT')
            elif ph == 'TRIAL_RESULT':
                players[turn % 3].act({'type': 'CONTINUE'})
                room_host.wait(lambda x, s=v['seq']: x['seq'] > s)
            elif ph == 'TIEBREAK_CHOICE':
                room_host.act({'type': 'RESOLVE_TIE', 'mode': 'SHARE'})
                room_host.wait(lambda x, s=v['seq']: x['seq'] > s)
            elif ph == 'CHALLENGE':
                ch = v['challenge']
                seen.add(ch['type'])
                if ch['stage'] == 'INTRO':
                    room_host.act({'type': 'CHALLENGE_BEGIN'})
                elif ch['stage'] == 'RESULT':
                    room_host.act({'type': 'CONTINUE'})
                else:
                    cur = v['pendingActors'][0]
                    actor = [c for c in players if c.me == cur][0]
                    others = [c for c in players if c.me != cur]
                    others[0].act({'type': 'SD_PLACE' if ch['type'] == 'SUDDEN_DEATH' else 'MOL_GUESS',
                                   'playerId': cur, 'slot': 0, 'year': 0}, expect_ok=False)   # not their turn
                    if ch['type'] == 'SUDDEN_DEATH':
                        y = YEARS[ch['sd']['currentCardId']]
                        line = [YEARS[c] for c in ch['sd']['timeline']]
                        slot = sum(1 for t in line if t < y)
                        if actor is not players[-1]:            # make non-final players misplace
                            slot = len(line) if slot == 0 else 0
                        actor.act({'type': 'SD_PLACE', 'playerId': cur, 'slot': slot})
                    else:
                        lo, hi = -9999, 9999
                        for g in ch['mol']['guesses']:
                            if g['verdict'] == 'more':
                                lo = max(lo, g['year'] + 1)
                            if g['verdict'] == 'less':
                                hi = min(hi, g['year'] - 1)
                        actor.act({'type': 'MOL_GUESS', 'playerId': cur, 'year': (lo + hi) // 2})
                room_host.wait(lambda x, s=v['seq']: x['seq'] > s)
        final = [c.wait(lambda x: x['phase'] == 'GAME_OVER') for c in players]
        assert all(f['winners'] == final[0]['winners'] and f['players'] == final[0]['players'] for f in final)
        assert final[0]['winners'], 'there is a winner'
        assert 'SUDDEN_DEATH' in seen and 'MORE_OR_LESS' in seen, 'both Challenges were played: %s' % seen
        for c in players:
            assert not c.privacy_errors, c.privacy_errors
        room_host.act({'type': 'ROOM_REMATCH'})
        for c in players:
            c.wait(lambda x: x['phase'] == 'LOBBY' and len(x['players']) == 3 and x['room']['me'])
        D.act({'type': 'ROOM_REMATCH'}, expect_ok=False)
        for c in players:
            c.close()
    test('Full 3-player game over the network: Challenges, Sudden Death, More or Less, Finish, Game Over, rematch',
         full_game)

    def privacy():
        for c in (A, B, C):
            assert not c.privacy_errors, c.privacy_errors
        for secret in ('/server/server.py', '/server/data/rooms.json', '/.venv/pyvenv.cfg', '/RULES.md'):
            conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=5)
            conn.request('GET', secret)
            status = conn.getresponse().status
            conn.close()
            assert status == 404, '%s served (%d)' % (secret, status)
    test('No frame ever leaked an unrevealed date, an answer, the RNG or the deck order', privacy)

    proc.terminate()
    passed = sum(1 for _, ok, _ in results if ok)
    print('\n%s %d/%d' % ('PASS' if passed == len(results) else 'FAIL', passed, len(results)), flush=True)
    os._exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    main()
