# Timeline Challenge — Web Game

เกมกระดาน **Timeline Challenge** เวอร์ชันเว็บ เล่น 2–10 คน (Traveler 10 ตัว) ได้ทั้งแบบ pass-and-play บนเครื่องเดียว และออนไลน์ข้ามเครื่อง

- กติกาที่ใช้: [RULES.md](RULES.md) (`file.txt` = spec ของโปรเจกต์, ตัวเลขกติกาจาก rulebook ทางการ)
- ไม่ต้องติดตั้งอะไร ไม่มี build step ไม่มี dependency

## วิธีเล่น / รัน

ดับเบิลคลิก `index.html` ได้เลย หรือรันผ่าน local server:

```bash
python -m http.server 8765
```

แล้วเปิด http://localhost:8765

แบบเครื่องเดียว: เกมบันทึกอัตโนมัติใน `localStorage` — refresh หรือปิดแท็บแล้วเปิดใหม่ เล่นต่อได้จากจุดเดิม
แบบออนไลน์: ดูหัวข้อ "เล่นออนไลน์" ด้านล่าง (ต้องรัน server)

## ทดสอบ

เปิด http://localhost:8765/tests/ — ต้องขึ้น `PASS 34/34`
ครอบคลุม: ตัวอย่างทุกข้อใน rulebook, setup, การตอบซ้ำ/ส่งซ้ำ/ผิดคน/ผิด phase, leader กำหนด Trial,
ผู้นำเสมอกัน, Challenge trigger + ผู้เข้าร่วม + ลำดับ, Sudden Death หลายคน, More or Less,
กติกา 2 ผู้เล่น, เกมจบระหว่าง movement, เสมอที่ Finish, refresh, reshuffle กอง และจำลองเกมเต็ม 100 เกม
โดยตรวจว่าการ์ดทุกใบอยู่ที่เดียวเสมอ

## โครงสร้าง

```
js/engine/   Game logic — ไม่มี DOM, รันบน server (Node) ได้ทันที
  core.js        namespace, RNG แบบ seed (อยู่ใน state), RuleError
  rules.js       ค่าคงที่กติกาทั้งหมด: Timeline, Clock track, Trials, Challenges, tokens
  deck.js        Card Engine: shuffle / draw / reveal / discard / reshuffle
  trials.js      Trial Engine: validate + ให้คะแนน 5 Trial
  movement.js    Movement Engine: เดิน, หยุดที่ Finish, หาผู้นำ
  challenges.js  Challenge Engine: ผู้เข้าร่วม, ลำดับเข็มนาฬิกา, Sudden Death, More or Less
  game.js        Game Engine: state machine + applyAction + getView
js/data/cards.js การ์ด 180+ ใบ (เพิ่มได้โดยต่อแถว)
js/ui/           แสดงผลเท่านั้น — ส่ง action เข้า engine (เครื่องเดียว) หรือ server (ออนไลน์)
  online.js        transport: POST action + รับ view ผ่าน Server-Sent Events
server/          online server (Python) — รัน js/engine ตัวเดิมใน V8
  server.py        ห้อง, ที่นั่ง, สิทธิ์, broadcast, บันทึกห้อง
  engine_host.py   โหลด js/engine/*.js เข้า V8
  test_online.py   end-to-end test หลาย client
tests/           engine tests (รันในเบราว์เซอร์)
```

### State machine

```
LOBBY → TRIAL_INPUT → TRIAL_RESULT → (ตรวจ Finish → ตรวจเส้น Challenge → Trial ตามช่องผู้นำ)
                                        ├→ GAME_OVER / TIEBREAK_CHOICE
                                        └→ CHALLENGE (INTRO → PLAY → RESULT) → (ตรวจซ้ำ)
```

## เล่นออนไลน์ (Online Multiplayer)

### สถาปัตยกรรม

```
Browser A ──POST action──▶ ┌────────────────────────────┐ ◀──POST action── Browser B
          ◀──SSE view───── │ server/server.py (Python)   │ ───SSE view───▶
                           │  • ห้อง / ที่นั่ง / สิทธิ์      │
                           │  • js/engine/*.js ตัวเดิม    │  ← รันใน V8 (mini-racer)
                           │    = ผู้ตัดสินกติกาตัวเดียว     │
                           └────────────────────────────┘
```

- **Server-authoritative:** state เต็มอยู่บน server เท่านั้น client ส่งแค่ action
- **ตรวจสองชั้น:** server ตรวจก่อนว่าใครส่ง (ทำแทนคนอื่นไม่ได้, บางคำสั่งเฉพาะหัวห้อง) แล้ว engine ตรวจกติกา
- **ข้อมูลลับ:** client ได้รับแค่ `getView()` ซึ่งไม่มีปีการ์ดที่ยังไม่เปิด, คำตอบของคนอื่นก่อน Reveal, ลำดับกอง และ RNG
- **Real-time:** ใช้ Server-Sent Events, browser ต่อใหม่เองอัตโนมัติเมื่อหลุด
- **Reconnect:** แต่ละแท็บเก็บ token ประจำตัวไว้ใน sessionStorage (เก็บ*ตัวตน* ไม่ใช่ state) refresh แล้วกลับที่นั่งเดิม ปิดแท็บแล้วเปิดใหม่มีปุ่ม "กลับเข้าห้อง…"
- **ห้องไม่หายเมื่อรีสตาร์ท server:** ห้องถูกบันทึกลง `server/data/rooms.json` ห้องที่ไม่มีคนเข้า 24 ชม. จะถูกลบ
- **ผู้เล่น:** 2–10 คน คนละ 1 Traveler ไม่ซ้ำกัน (Traveler มี 10 ตัว) ห้องรับได้ 10 คน คนที่ 11 เข้าไม่ได้
  - Traveler ที่ถูกเลือกแล้วจะขึ้นว่า "ไม่ว่าง" — server ล็อกคำสั่งทีละคำสั่ง จึงไม่มีทางได้ตัวซ้ำแม้กดพร้อมกันจากหลายเครื่อง
  - ออกจากห้องตอนอยู่ในห้องรอ = คืน Traveler และที่ว่างให้คนอื่นทันที ส่วนระหว่างเกม "ออกจากห้อง" แค่ตัดการเชื่อมต่อ กลับมาเล่น Traveler เดิมต่อได้
  - คนที่เข้าห้องหลังเริ่มเกม (ถ้าห้องยังไม่เต็ม) เป็นผู้ชม

### รันบนเครื่อง

```bash
python -m venv .venv
```

```bash
.venv/Scripts/python -m pip install -r server/requirements.txt
```

```bash
.venv/Scripts/python server/server.py
```

เปิด http://127.0.0.1:8765 (บน macOS/Linux ใช้ `.venv/bin/python`)
ตัวแปรเสริม: `HOST` (ค่าเริ่มต้น 127.0.0.1 — ใช้ 0.0.0.0 ถ้าจะให้เครื่องอื่นในวงแลนเข้า), `PORT`, `TC_DATA`

### Deploy ขึ้นอินเทอร์เน็ต

มี `Dockerfile` + `render.yaml` พร้อมใช้:

1. push โฟลเดอร์นี้ขึ้น GitHub
2. สมัคร https://render.com → **New + → Blueprint** → เลือก repo → Deploy
3. ได้ URL `https://<ชื่อ>.onrender.com` ส่งให้เพื่อนได้เลย

ใช้กับโฮสต์ที่รัน Docker ได้ทุกเจ้า (Railway, Fly.io, VPS) — server อ่านพอร์ตจาก env `PORT`

### Create / Join

1. หน้าแรก → ใส่ชื่อ → **สร้างห้องใหม่** → ได้รหัสห้อง 5 ตัว + ปุ่ม **คัดลอกลิงก์เชิญ**
2. เพื่อนเปิดลิงก์เชิญ (หรือใส่รหัสห้อง) → ใส่ชื่อ → **เข้าห้อง**
3. ทุกคนเลือก Traveler ของตัวเอง (ตัวที่ว่าง) → กดพร้อม → หัวห้องกด **เริ่มเกม**

### ทดสอบ

```bash
.venv/Scripts/python server/test_online.py
```

รัน server จริงแล้วใช้ client อิสระหลายตัวผ่าน HTTP+SSE: create/join, สิทธิ์, คำตอบลับ, reveal พร้อมกัน, sync movement/Trial,
ผู้ชม, reconnect, รีสตาร์ท server, เกมเต็ม 3 คนจนจบ (Sudden Death + More or Less + Finish + Game Over + rematch)
และตรวจทุก frame ว่าไม่มีข้อมูลลับหลุด — ต้องขึ้น `PASS 16/16` (รวมเกมเต็ม 2, 3, 5, 6, 10 คน, ห้องเต็ม 10 คน, คืน Traveler, กดพร้อมกันหลายเครื่อง)
