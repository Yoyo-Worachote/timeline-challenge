#!/usr/bin/env python3
"""
Timeline Challenge — online multiplayer server.

Server-authoritative: the full game state lives only here. Clients send actions over HTTP,
the server checks *who* may send them, the shared JS engine checks the rules, and every
client receives its view over Server-Sent Events. Views never contain unrevealed card dates
or other players' answers.

Run:  python server/server.py            (HOST / PORT / TC_DATA env vars are optional)
"""
import json
import os
import queue
import re
import secrets
import select
import socket
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine_host import Engine  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = Path(os.environ.get('TC_DATA', ROOT / 'server' / 'data' / 'rooms.json'))

CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'  # no 0/O, 1/I/L
CODE_LENGTH = 5
MAX_ROOMS = 500
STALE_SECONDS = 60       # an offline lobby member without a Traveler may be dropped to make room after this
ROOM_TTL = 24 * 3600     # idle rooms are deleted after a day
HOST_GRACE = 120         # seconds a host may be offline before a seated player can take over
MAX_BODY = 16 * 1024
MAX_NAME = 24
PING_SECONDS = 15
STATIC_FILES = {'/': 'index.html', '/index.html': 'index.html'}
STATIC_PREFIXES = ('/css/', '/js/', '/tests/')

# Actions a player may only send for their own Traveler.
SELF_ACTIONS = {'SET_READY', 'SUBMIT_ANSWER', 'SD_PLACE', 'MOL_GUESS'}
# Actions any seated player may send (the engine decides whether they are legal now).
SEATED_ACTIONS = {'CONTINUE', 'CHALLENGE_BEGIN'}


class Denied(Exception):
    pass


def clean_name(value):
    name = re.sub(r'\s+', ' ', str(value or '')).strip()
    if not name:
        raise Denied('กรุณาใส่ชื่อ')
    if len(name) > MAX_NAME:
        raise Denied('ชื่อยาวเกิน %d ตัวอักษร' % MAX_NAME)
    return name


class Room:
    def __init__(self, code, state, host_token):
        self.code = code
        self.state = state
        self.host = host_token
        self.clients = {}       # client token -> {'name', 'playerId'}
        self.listeners = {}     # client token -> set of Queue (one per open tab)
        self.last_seen = {}     # client token -> time of last connection activity
        self.touched = time.time()

    def to_json(self):
        return {'code': self.code, 'state': self.state, 'host': self.host,
                'clients': self.clients, 'touched': self.touched}

    @classmethod
    def from_json(cls, data):
        room = cls(data['code'], data['state'], data['host'])
        room.clients = data.get('clients', {})
        room.touched = data.get('touched', time.time())
        return room

    def online(self, token):
        return bool(self.listeners.get(token))

    def player_ids(self):
        return [p['id'] for p in self.state['players']]


class Hub:
    def __init__(self, engine):
        self.engine = engine
        self.capacity = engine.max_players()   # people per room = Travelers (10)
        self.rooms = {}
        self.lock = threading.RLock()
        self.dirty = False
        self.load()

    # ------------------------------------------------------------ persistence

    def load(self):
        try:
            data = json.loads(DATA_FILE.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return
        for raw in data.get('rooms', []):
            try:
                room = Room.from_json(raw)
                if self.engine.restore(room.state) is not None:
                    self.rooms[room.code] = room
            except (KeyError, TypeError):
                continue

    def save_now(self):
        with self.lock:
            if not self.dirty:
                return
            payload = json.dumps({'rooms': [r.to_json() for r in self.rooms.values()]})
            self.dirty = False
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = DATA_FILE.with_suffix('.tmp')
        tmp.write_text(payload, encoding='utf-8')
        os.replace(tmp, DATA_FILE)

    def background(self):
        while True:
            time.sleep(2)
            try:
                self.sweep()
                self.save_now()
            except Exception as exc:  # keep the worker alive
                print('background error:', exc, file=sys.stderr)

    def sweep(self):
        now = time.time()
        with self.lock:
            for code in list(self.rooms):
                room = self.rooms[code]
                if not any(room.listeners.values()) and now - room.touched > ROOM_TTL:
                    del self.rooms[code]
                    self.dirty = True

    # ------------------------------------------------------------ rooms

    def new_code(self):
        while True:
            code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if code not in self.rooms:
                return code

    def get(self, code):
        room = self.rooms.get(str(code or '').upper())
        if not room:
            raise Denied('ไม่พบห้องนี้ (รหัสผิด หรือห้องหมดอายุแล้ว)')
        return room

    def client(self, room, token):
        c = room.clients.get(token)
        if not c:
            raise Denied('ไม่พบผู้เล่นในห้องนี้ — กรุณาเข้าห้องใหม่')
        return c

    def create_room(self, name):
        name = clean_name(name)
        with self.lock:
            if len(self.rooms) >= MAX_ROOMS:
                raise Denied('เซิร์ฟเวอร์มีห้องเต็มแล้ว ลองใหม่ภายหลัง')
            token = secrets.token_urlsafe(24)
            room = Room(self.new_code(), self.engine.create_lobby(secrets.randbits(32)), token)
            room.clients[token] = {'name': name, 'playerId': None}
            room.last_seen[token] = time.time()
            self.rooms[room.code] = room
            self.dirty = True
            return room.code, token

    def join(self, code, name, token=None):
        """A room holds at most `capacity` people (one per Traveler). Reconnects always succeed."""
        with self.lock:
            room = self.get(code)
            if token and token in room.clients:            # reconnect: same identity, same Traveler
                return room.code, token, room.clients[token]['name']
            name = clean_name(name)
            if len(room.clients) >= self.capacity:
                self.drop_stale(room)
            if len(room.clients) >= self.capacity:
                raise Denied('ห้องเต็มแล้ว (%d / %d คน)' % (len(room.clients), self.capacity))
            token = secrets.token_urlsafe(24)
            room.clients[token] = {'name': name, 'playerId': None}
            room.last_seen[token] = time.time()
            room.touched = time.time()
            self.dirty = True
        self.broadcast(room)
        return room.code, token, name

    def drop_stale(self, room):
        """In the lobby, people who left without a Traveler and stayed away free their place."""
        if room.state['phase'] != 'LOBBY':
            return
        now = time.time()
        for t in list(room.clients):
            c = room.clients[t]
            if not c.get('playerId') and not room.online(t) and now - room.last_seen.get(t, 0) > STALE_SECONDS:
                self.remove_client(room, t)

    def remove_client(self, room, token):
        """Drop a person from the room; their Traveler (lobby only) goes back to the pool."""
        seat = room.clients[token].get('playerId')
        if seat:
            result = self.engine.apply(room.state, {'type': 'REMOVE_PLAYER', 'playerId': seat})
            if not result['ok']:
                raise Denied(result['error'])
            room.state = result['state']
        del room.clients[token]
        room.listeners.pop(token, None)
        room.last_seen.pop(token, None)
        if token == room.host and room.clients:
            seated = [t for t, c in room.clients.items() if c.get('playerId')]
            room.host = (seated or list(room.clients))[0]

    # ------------------------------------------------------------ actions

    def is_host(self, room, token):
        """The creator is host. If the host has been gone a while, a seated player takes over."""
        if token == room.host:
            return True
        host_gone = not room.online(room.host) and \
            time.time() - room.last_seen.get(room.host, 0) > HOST_GRACE
        if host_gone and room.clients.get(token, {}).get('playerId'):
            room.host = token
            return True
        return False

    def act(self, code, token, action):
        if not isinstance(action, dict) or not isinstance(action.get('type'), str):
            raise Denied('คำสั่งไม่ถูกต้อง')
        with self.lock:
            room = self.get(code)
            client = self.client(room, token)
            seat = client.get('playerId')
            kind = action['type']
            lobby = room.state['phase'] == 'LOBBY'

            if kind.startswith('ROOM_'):
                self.room_action(room, token, client, kind, action, lobby)
            else:
                if kind == 'ADD_PLAYER':
                    if seat:
                        raise Denied('คุณมี Traveler แล้ว')
                    action = {'type': kind, 'name': action.get('name'), 'token': action.get('token'),
                              'members': '', 'seq': action.get('seq')}
                elif kind in SELF_ACTIONS:
                    if not seat or action.get('playerId') != seat:
                        raise Denied('ทำแทนผู้เล่นคนอื่นไม่ได้')
                elif kind in SEATED_ACTIONS:
                    if not seat:
                        raise Denied('ผู้ชมทำรายการนี้ไม่ได้')
                elif kind in ('START_GAME', 'REMOVE_PLAYER'):
                    if not self.is_host(room, token):
                        raise Denied('เฉพาะหัวห้องเท่านั้น')
                elif kind == 'RESOLVE_TIE':
                    tied = (room.state.get('tie') or {}).get('playerIds', [])
                    if seat not in tied and not self.is_host(room, token):
                        raise Denied('เฉพาะผู้เล่นที่เสมอกันหรือหัวห้อง')
                else:
                    raise Denied('คำสั่งไม่ถูกต้อง')

                if action.get('seq') is None:
                    action.pop('seq', None)
                result = self.engine.apply(room.state, action)
                if not result['ok']:
                    raise Denied(result['error'])
                room.state = result['state']
                if kind == 'ADD_PLAYER':
                    client['playerId'] = result['value']
                self.drop_orphan_seats(room)

            room.touched = time.time()
            self.dirty = True
        self.broadcast(room)

    def room_action(self, room, token, client, kind, action, lobby):
        seat = client.get('playerId')
        if kind == 'ROOM_LEAVE_SEAT':
            # Give the Traveler back but stay in the room (e.g. to pick another one).
            if not lobby:
                raise Denied('เปลี่ยน Traveler ได้เฉพาะก่อนเริ่มเกม')
            if not seat:
                raise Denied('คุณยังไม่มี Traveler')
            result = self.engine.apply(room.state, {'type': 'REMOVE_PLAYER', 'playerId': seat})
            if not result['ok']:
                raise Denied(result['error'])
            room.state = result['state']
            client['playerId'] = None
        elif kind == 'ROOM_LEAVE':
            # Leave the room for good. Mid-game a Traveler cannot leave the race (the engine has no
            # such rule), so players just disconnect and may reconnect; spectators can leave any time.
            if seat and not lobby:
                raise Denied('ออกจากเกมที่กำลังเล่นไม่ได้ — ปิดหน้าเว็บได้ แล้วกลับเข้ามาต่อภายหลัง')
            self.remove_client(room, token)
        elif kind == 'ROOM_REMATCH':
            if not self.is_host(room, token):
                raise Denied('เฉพาะหัวห้องเท่านั้น')
            room.state = self.engine.rematch(room.state, secrets.randbits(32))
        else:
            raise Denied('คำสั่งไม่ถูกต้อง')

    def drop_orphan_seats(self, room):
        ids = set(room.player_ids())
        for c in room.clients.values():
            if c.get('playerId') and c['playerId'] not in ids:
                c['playerId'] = None

    # ------------------------------------------------------------ views

    def meta(self, room, token):
        members = []
        for t, c in room.clients.items():
            members.append({'name': c['name'], 'playerId': c.get('playerId'),
                            'online': room.online(t), 'host': t == room.host, 'me': t == token})
        me = room.clients.get(token, {})
        return {'code': room.code, 'me': me.get('playerId'), 'myName': me.get('name'),
                'isHost': token == room.host, 'members': members, 'capacity': self.capacity}

    def broadcast(self, room):
        with self.lock:
            base = self.engine.view(room.state)
            targets = [(t, list(qs)) for t, qs in room.listeners.items() if qs]
            payloads = [(qs, self.encode(base, room, t)) for t, qs in targets]
        for qs, data in payloads:
            for q in qs:
                push(q, data)

    def encode(self, base, room, token):
        view = dict(base)
        view['room'] = self.meta(room, token)
        return json.dumps(view, ensure_ascii=False).encode('utf-8')

    def subscribe(self, code, token):
        with self.lock:
            room = self.get(code)
            self.client(room, token)
            q = queue.Queue(maxsize=64)
            room.listeners.setdefault(token, set()).add(q)
            room.last_seen[token] = time.time()
        self.broadcast(room)   # presence changed for everyone (and first snapshot for this tab)
        return room, q

    def unsubscribe(self, room, token, q):
        with self.lock:
            room.listeners.get(token, set()).discard(q)
            room.last_seen[token] = time.time()
        self.broadcast(room)


def push(q, data):
    try:
        q.put_nowait(data)
    except queue.Full:            # a stalled tab only ever needs the newest view
        try:
            q.get_nowait()
        except queue.Empty:
            pass
        q.put_nowait(data)


class Handler(SimpleHTTPRequestHandler):
    server_version = 'TimelineChallenge/1.0'
    hub = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if os.environ.get('TC_QUIET') != '1':
            super().log_message(fmt, *args)

    # ------------------------------------------------------------ helpers

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_BODY:
            raise Denied('ข้อมูลใหญ่เกินไป')
        try:
            data = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            raise Denied('ข้อมูลไม่ถูกต้อง')
        if not isinstance(data, dict):
            raise Denied('ข้อมูลไม่ถูกต้อง')
        return data

    def end_headers(self):
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    # ------------------------------------------------------------ routing

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path == '/api/health':
            return self.send_json(200, {'ok': True, 'rooms': len(self.hub.rooms)})
        m = re.fullmatch(r'/api/rooms/([A-Za-z0-9]+)/stream', path)
        if m:
            token = (parse_qs(url.query).get('token') or [''])[0]
            return self.stream(m.group(1), token)
        if path.startswith('/api/'):
            return self.send_json(404, {'ok': False, 'error': 'not found'})
        # Static files: only the game's own client files.
        if path in STATIC_FILES:
            self.path = '/' + STATIC_FILES[path]
            return super().do_GET()
        if path.startswith(STATIC_PREFIXES) and '..' not in path:
            return super().do_GET()
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self.read_json()
            if path == '/api/rooms':
                code, token = self.hub.create_room(data.get('name'))
                return self.send_json(200, {'ok': True, 'code': code, 'token': token})
            m = re.fullmatch(r'/api/rooms/([A-Za-z0-9]+)/(join|action)', path)
            if not m:
                return self.send_json(404, {'ok': False, 'error': 'not found'})
            code, op = m.group(1), m.group(2)
            if op == 'join':
                code, token, name = self.hub.join(code, data.get('name'), data.get('token'))
                return self.send_json(200, {'ok': True, 'code': code, 'token': token, 'name': name})
            self.hub.act(code, str(data.get('token') or ''), data.get('action'))
            return self.send_json(200, {'ok': True})
        except Denied as exc:
            return self.send_json(400, {'ok': False, 'error': str(exc)})

    def peer_closed(self):
        """An EventSource never sends after its request, so a readable socket means it hung up."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b''
        except (OSError, ValueError):
            return True

    def stream(self, code, token):
        try:
            room, q = self.hub.subscribe(code, token)
        except Denied as exc:
            return self.send_json(404, {'ok': False, 'error': str(exc)})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')   # disable proxy buffering
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        try:
            # 2 KB comment first: makes buffering proxies (corporate, some PaaS) flush the stream at once.
            self.wfile.write(b':' + b' ' * 2048 + b'\nretry: 2000\n\n')
            self.wfile.flush()
            idle = 0.0
            while True:
                try:
                    data = q.get(timeout=1)
                    self.wfile.write(b'data: ' + data + b'\n\n')
                    idle = 0.0
                except queue.Empty:
                    if self.peer_closed():
                        break
                    idle += 1
                    if idle < PING_SECONDS:
                        continue
                    self.wfile.write(b': ping\n\n')   # keeps proxies from closing an idle stream
                    idle = 0.0
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            self.hub.unsubscribe(room, token, q)


def main():
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', '8765'))
    Handler.hub = Hub(Engine())
    threading.Thread(target=Handler.hub.background, daemon=True).start()
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    print('Timeline Challenge server on http://%s:%d' % (host, port), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Handler.hub.save_now()
        os._exit(0)   # mini-racer's V8 threads would otherwise keep the process alive


if __name__ == '__main__':
    main()
