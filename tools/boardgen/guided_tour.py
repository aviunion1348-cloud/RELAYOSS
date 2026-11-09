#!/usr/bin/env python3
"""
Generator for docs/architecture/RELAYOS_GUIDED_TOUR.{excalidraw,svg,png}

A guided tour of the codebase for a reader who has never opened it, carrying the
same depth as the engineering masterboard: every claim that says "enforced" shows
the file, the line and the actual code that enforces it.

Three registers, deliberately:
  bold title      plain English
  normal body     the detail, still in sentences
  mono on slate   the exact path, line number, or real statement

Run:  python3 tools/boardgen/guided_tour.py
"""
from __future__ import annotations
import json, math, os, random, sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = ImageDraw = ImageFont = None

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'docs', 'architecture'))
NAME = 'RELAYOS_GUIDED_TOUR'

FD = '/usr/share/fonts/truetype/dejavu'
FONT_R = os.path.join(FD, 'DejaVuSans.ttf')
FONT_B = os.path.join(FD, 'DejaVuSans-Bold.ttf')
FONT_M = os.path.join(FD, 'DejaVuSansMono.ttf')

INK, MUTED, FAINT = '#1f2937', '#475569', '#94a3b8'
BLUE, GREEN, AMBER = ('#eff6ff', '#2563eb'), ('#ecfdf5', '#059669'), ('#fffbeb', '#d97706')
VIOLET, ROSE, GREY = ('#f5f3ff', '#7c3aed'), ('#fff1f2', '#e11d48'), ('#f8fafc', '#94a3b8')
RED, WHITE = ('#fef2f2', '#dc2626'), ('#ffffff', '#cbd5e1')
SLATE = ('#f1f5f9', '#cbd5e1')

W, M, BODY, LH = 2400, 60, 17, 1.25
MONO_FS, MONO_LH = 15, 1.5

_rng = random.Random(77713)
_el: list[dict] = []
_geom: dict[str, tuple] = {}
_bold: dict[str, bool] = {}
_mono: dict[str, bool] = {}
_fc: dict = {}


def _f(size, kind='r'):
    k = (size, kind)
    if k not in _fc and ImageFont is not None:
        path = {'r': FONT_R, 'b': FONT_B, 'm': FONT_M}[kind]
        _fc[k] = ImageFont.truetype(path, size)
    return _fc.get(k)


def measure(s, size, bold=False, mono=False):
    f = _f(size, 'm' if mono else ('b' if bold else 'r'))
    return f.getlength(s) if f is not None else len(s) * size * (0.6 if mono else 0.52)


def wrap(s, size, maxw, bold=False):
    out, cur = [], ''
    for word in s.split():
        t = (cur + ' ' + word).strip()
        if not cur or measure(t, size, bold) <= maxw:
            cur = t
        else:
            out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out


def _id():
    import base64
    return base64.b32encode(_rng.getrandbits(64).to_bytes(8, 'big')).decode().rstrip('=').lower()[:14]


def _mk(t, x, y, w, h, stroke, fill='transparent', dashed=False, width=2, radius=True, frame=None):
    e = {'id': _id(), 'type': t, 'x': round(x, 2), 'y': round(y, 2),
         'width': round(w, 2), 'height': round(h, 2), 'angle': 0,
         'strokeColor': stroke, 'backgroundColor': fill, 'fillStyle': 'solid',
         'strokeWidth': width, 'strokeStyle': 'dashed' if dashed else 'solid',
         'roughness': 0, 'opacity': 100, 'groupIds': [], 'frameId': frame,
         'roundness': {'type': 3} if radius else None,
         'seed': _rng.getrandbits(31), 'version': 1, 'versionNonce': _rng.getrandbits(31),
         'isDeleted': False, 'boundElements': [], 'updated': 1762000000000,
         'link': None, 'locked': False}
    _el.append(e)
    if t == 'rectangle':
        _geom[e['id']] = (x, y, w, h)
    return e


def rect(x, y, w, h, tone=WHITE, dashed=False, width=2, frame=None):
    return _mk('rectangle', x, y, w, h, tone[1], tone[0], dashed, width, True, frame)


def txt(x, y, lines, size=BODY, color=INK, bold=False, mono=False, frame=None):
    if isinstance(lines, str):
        lines = [lines]
    s = '\n'.join(lines)
    w = max(measure(l, size, bold, mono) for l in lines) if lines else 1
    h = len(lines) * size * (MONO_LH if mono else LH)
    e = _mk('text', x, y, w, h, color, 'transparent', False, 1, False, frame)
    _bold[e['id']] = bold
    _mono[e['id']] = mono
    e.update({'text': s, 'originalText': s, 'fontSize': size,
              'fontFamily': 3 if mono else 2, 'textAlign': 'left', 'verticalAlign': 'top',
              'lineHeight': MONO_LH if mono else LH, 'containerId': None, 'autoResize': True})
    return e


def para(x, y, s, size=BODY, color=MUTED, bold=False, maxw=700, frame=None):
    lines = wrap(s, size, maxw, bold)
    txt(x, y, lines, size, color, bold, False, frame)
    return len(lines) * size * LH


def arrow(a, b, side='right', label=None, color='#94a3b8'):
    ax, ay, aw, ah = _geom[a]
    bx, by, bw, bh = _geom[b]
    if side == 'right':
        sx, sy, ex, ey = ax + aw, ay + ah / 2, bx, by + bh / 2
    elif side == 'down':
        sx, sy, ex, ey = ax + aw / 2, ay + ah, bx + bw / 2, by
    else:
        sx, sy, ex, ey = ax + aw / 2, ay, bx + bw / 2, by + bh
    e = _mk('arrow', sx, sy, abs(ex - sx), abs(ey - sy), color, 'transparent', False, 2, False, None)
    e.update({'points': [[0, 0], [round(ex - sx, 2), round(ey - sy, 2)]], 'lastCommittedPoint': None,
              'startBinding': {'elementId': a, 'focus': 0, 'gap': 8},
              'endBinding': {'elementId': b, 'focus': 0, 'gap': 8},
              'startArrowhead': None, 'endArrowhead': 'arrow', 'elbowed': False})
    for eid in (a, b):
        for el in _el:
            if el['id'] == eid:
                el['boundElements'].append({'type': 'arrow', 'id': e['id']})
                break
    if label:
        lw = measure(label, 15) + 22
        lx = (sx + ex) / 2 - lw / 2
        ly = (sy + ey) / 2 - 14
        r = rect(lx, ly, lw, 28, WHITE, width=1)
        r['backgroundColor'] = '#ffffff'
        txt(lx + 11, ly + 6, [label], 15, MUTED)


class Frame:
    def __init__(self, title, subtitle, y):
        self.y, self.cursor, self.bottom = y, y + 128, y + 128
        self.last_h = 0
        self.e = _mk('frame', 0, y, W, 900, '#93c5fd', 'transparent', False, 1, False, None)
        self.e['name'] = title
        self.id = self.e['id']
        txt(24, y + 24, [title], 34, INK, True, False, self.id)
        txt(26, y + 76, [subtitle], 17, MUTED, False, False, self.id)

    def place(self, b):
        self.bottom = max(self.bottom, b)

    # ---- heights -------------------------------------------------------
    def card_h(self, w, title, body, code=None, ts=21, bs=BODY):
        pad = 22
        inner = w - 2 * pad
        th = ts * LH if title else 0
        bl = wrap(body, bs, inner) if body else []
        bh = len(bl) * bs * LH
        ch = self.code_h(code, inner) if code else 0
        return pad + th + (8 if bl else 0) + bh + (12 + ch if code else 0) + pad

    @staticmethod
    def code_h(code, w):
        if not code:
            return 0
        return len(code) * MONO_FS * MONO_LH + 20

    def card(self, x, y, w, title, body, tone=WHITE, code=None, force_h=None,
             ts=21, bs=BODY, code_color=MUTED, dashed=False):
        pad = 22
        inner = w - 2 * pad
        h = force_h or self.card_h(w, title, body, code, ts, bs)
        r = rect(x, y, w, h, tone, dashed, 2, self.id)
        cy = y + pad
        if title:
            txt(x + pad, cy, [title], ts, INK, True, False, self.id)
            cy += ts * LH
        if body:
            bl = wrap(body, bs, inner)
            txt(x + pad, cy + (8 if title else 0), bl, bs, MUTED, False, False, self.id)
            cy += (8 if title else 0) + len(bl) * bs * LH
        if code:
            cy += 12
            self.codebox(x + pad, cy, inner, code, self.id, code_color)
        self.place(y + h)
        self.last_h = h
        return r['id']

    def codebox(self, x, y, w, lines, frame, color=MUTED):
        h = len(lines) * MONO_FS * MONO_LH + 20
        r = rect(x, y, w, h, ('#eef2f7', '#cbd5e1'), width=1, frame=frame)
        txt(x + 12, y + 10, lines, MONO_FS, '#334155', False, True, frame)
        return h

    def band(self, y, s, tone=('#f0f9ff', '#0284c7'), size=18, bold=False, h=None):
        pad = 20
        lines = wrap(s, size, W - 2 * M - 2 * pad, bold)
        hh = h or len(lines) * size * LH + 2 * pad
        rect(M, y, W - 2 * M, hh, tone, False, 2, self.id)
        txt(M + pad, y + pad, lines, size, INK if bold else MUTED, bold, False, self.id)
        self.place(y + hh)
        return hh

    def label(self, x, y, s, size=19):
        txt(x, y, [s], size, INK, True, False, self.id)
        self.place(y + size * LH)

    def chip(self, x, y, label, tone=WHITE, dashed=False):
        padx, h, fs = 13, 30, 15
        w = measure(label, fs) + 2 * padx
        rect(x, y, w, h, tone, dashed, 2, self.id)
        txt(x + padx, y + (h - fs * LH) / 2 + 1, [label], fs, INK, False, False, self.id)
        self.place(y + h)
        return w

    def finish(self, gap=110):
        h = math.ceil(self.bottom - self.y + 30)
        self.e['height'] = round(h, 2)
        return self.y + h + gap


def new(title, subtitle, y):
    return Frame(title, subtitle, y)


# =====================================================================
#  content
# =====================================================================
def build():
    y = 0

    # ---------------------------------------------------------------- 00
    f = new('00 · Read this first — what it is, and how to read the page',
            'Plain English in the big text. Real code underneath. If you read only the bold lines, you still get all of it.', y)
    c0 = f.cursor
    h = max(f.card_h(740, 'What RelayOS is',
                     'The back office for a design studio. It keeps clients, projects, tasks, approvals and deadline timers in one place, shared by the whole team.', ['apps/api/src/app.ts', 'apps/web/src/App.tsx']),
            f.card_h(740, 'How big it actually is',
                     'One program: 94 endpoints, 81 live tables, 17 migration files, 13 screens. No queue, no cache, no second service.', ['routes/index.ts ......... 3,370 lines', 'db/migrations/pg ......... 17 files']),
            f.card_h(740, 'The rule this page follows',
                     'Every claim names the file it came from. When a box says "enforced", there is a line of code that enforces it.',
                     ['docs/architecture/', '  RELAYOS_ARCHITECTURE_TRACEABILITY.md']))
    f.card(60, c0, 740, 'What RelayOS is',
           'The back office for a design studio. It keeps clients, projects, tasks, approvals and deadline timers in one place, shared by the whole team.',
           BLUE, code=['apps/api/src/app.ts', 'apps/web/src/App.tsx'], force_h=h)
    f.card(840, c0, 740, 'How big it actually is',
           'One program: 94 endpoints, 81 live tables, 17 migration files, 13 screens. No queue, no cache, no second service.',
           GREEN, code=['routes/index.ts ........ 3,370 lines', 'db/migrations/pg ........ 17 files'], force_h=h)
    f.card(1620, c0, 740, 'The rule this page follows',
           'Every claim names the file it came from. When a box says "enforced", a line of code enforces it and a test proves it.',
           VIOLET, code=['docs/architecture/', ' RELAYOS_ARCHITECTURE_TRACEABILITY.md'], force_h=h)

    yb = c0 + h + 40
    f.label(60, yb, 'Three registers, one page')
    yc = yb + 40
    f.card(60, yc, 740, 'Bold heading', 'The plain-English claim. Read only these and the tour still makes sense.', WHITE,
           code=['  What RelayOS is  ·  How it runs  ·  The rules'], ts=19)
    f.card(840, yc, 740, 'Grey sentence', 'The same fact with the detail that makes it useful: what, where, why it is that way.', WHITE,
           code=['  "…because a build cannot see a missing setting."'], ts=19)
    f.card(1620, yc, 740, 'Mono block', 'The file, the line number, or the actual statement. This is the part you can check.', WHITE,
           code=['  tasks.ts:119  SELECT id FROM columns', '  WHERE board_id = ? AND key = ?'], ts=19)
    f.band(yc + f.card_h(740, 'Mono block', 'x', ['  a']) + 30,
           'Depth is not in the length of the sentences. It is in every sentence being tied to a file you can open. Nothing on this page is a guess.',
           size=18)
    y = f.finish()

    # ---------------------------------------------------------------- 01
    f = new('01 · The whole system on one napkin',
            'Four boxes. Everything else on this page is a detail inside one of them.', y)
    c0 = f.cursor
    top = [('A person', 'Uses one browser tab. No install, no plugin.', WHITE, ['Chrome · Firefox · Safari'], 380),
           ('The browser tab', 'Loads the screens once, then talks to one address: /api.', WHITE, ['lib/api.ts:  BASE = "/api"'], 380),
           ('One program on Vercel', 'It serves the screens AND answers /api. One deploy, one address, one log stream.', BLUE,
            ['service "app" · vercel.json', 'screens: 16 embedded assets', 'api: 94 endpoints'], 700),
           ('PostgreSQL 16', 'One database. 81 live tables. All the rules that matter live here.', AMBER,
            ['DATABASE_URL', 'pool max 10'], 460)]
    h1 = max(f.card_h(w, t, b, c) for t, b, _, c, w in top)
    xs = [60, 560, 1060, 1880]
    ids = []
    for (t, b, tone, code, w), x in zip(top, xs):
        ids.append(f.card(x, c0, w, t, b, tone, code=code, force_h=h1))
    arrow(ids[0], ids[1], 'right')
    arrow(ids[1], ids[2], 'right', 'HTTPS')
    arrow(ids[2], ids[3], 'right', 'SQL')
    r2 = c0 + h1 + 40
    second = [('…and nothing else',
               'No queue, no worker, no cache, no object store, no second service. Each is a thing that can break, and none is needed yet.',
               WHITE, ['  ✗ redis   ✗ s3   ✗ kafka', '  ✗ sidekiq ✗ second API'], 1240, True),
              ('…and no login', 'Deliberately unauthenticated. Frame 10 says what that costs.', RED, ['authMode: "none"'], 1020, False)]
    h2 = max(f.card_h(w, t, b, c) for t, b, _, c, w, _ in second)
    for (t, b, tone, code, w, dash), sx in zip(second, (60, 1320)):
        f.card(sx, r2, w, t, b, tone, code=code, force_h=h2, dashed=dash)
    f.band(r2 + h2 + 34,
           'Why one program: the screens and the API are built and deployed together, so the browser calls /api on the address it was already loaded from. There is no second hostname, no CORS rule and no environment variable to get out of step.',
           size=18)
    y = f.finish()

    # ---------------------------------------------------------------- 02
    f = new('02 · What you can do — and the exact endpoint behind it',
            'Six areas of real work. The last column is the route and the line of code that serves it.', y)
    rows = [
        ('Dashboard', 'What is late, what is due this week, what is waiting on a client.', 'GET /api/dashboard', 'routes/index.ts:2204'),
        ('Clients', 'Every client, their contracts, and how far along the relationship is.', 'GET /api/clients', 'routes/index.ts:1474'),
        ('Projects', 'Phases, boards, budgets, and the tasks inside each column.', 'GET /api/projects', 'routes/index.ts:945'),
        ('Tasks', 'Create, assign, estimate, attach a checklist, record approvals step by step.', 'POST /api/tasks', 'routes/index.ts:412'),
        ('QA and releases', 'A gate that must pass before anything ships.', 'GET /api/releases/:id/gate', 'routes/index.ts:1975'),
        ('Deadline clocks', 'Timers that go running → met, missed, paused or waived.', 'GET /api/clocks', 'routes/index.ts:674'),
    ]
    yy = f.cursor
    hh = 96
    for name, plain, route, loc in rows:
        rect(60, yy, W - 2 * M, hh, WHITE, False, 2, f.id)
        txt(84, yy + 18, [name], 20, INK, True, False, f.id)
        txt(84, yy + 50, wrap(plain, 16, 800), 16, MUTED, False, False, f.id)
        txt(960, yy + 24, [route], 16, '#2563eb', True, True, f.id)
        txt(1560, yy + 24, [loc], 15, FAINT, False, True, f.id)
        txt(1560, yy + 52, ['the handler lives here'], 14, FAINT, False, False, f.id)
        f.place(yy + hh)
        yy += hh + 12
    f.band(yy + 10,
           'All 94 handlers live in that one file. It is 3,370 lines long, which is the single largest piece of debt in the repository — frame 13. It is also why every route is easy to find: one file, in order.',
           size=17)
    y = f.finish()

    # ---------------------------------------------------------------- 03
    f = new('03 · What happens when somebody clicks Save',
            'Eleven steps, about forty milliseconds. Every step names the line that does the work.', y)
    steps = [
        ('Your click', 'The button sends the form to the server.', ['apps/web/src/lib/api.ts', "fetch('/api/tasks', {POST})"]),
        ('The host', 'The platform sends every request to the one service.', ['vercel.json', 'rewrite: /(.*) → app']),
        ('The router', 'The server matches the method and the path.', ['routes/index.ts:412', "app.post('/api/tasks', …)"]),
        ('Before the handler', 'A hook runs first, on every single request.', ['app.ts:191', 'app.addHook("onRequest", …)']),
        ('Who is asking', 'One operator row is read and cached.', ['app.ts:493 → auth/operator-middleware.ts:68', 'resolveOperator(db) → usr_owner']),
        ('The form', 'Zod parses the body. Bad input stops here.', ['routes/index.ts (createSchema)', 'if (!parsed.success) → 400']),
        ('The rules', 'A service performs the multi-step write.', ['services/tasks.ts → createTask()', 'the only place that writes tasks']),
        ('The board', 'The column is looked up, never guessed.', ['tasks.ts:119', 'SELECT id FROM columns WHERE board_id=? AND key=?']),
        ('The key', 'Next key = highest suffix + 1, not row count.', ['tasks.ts:40 → nextKey()', 'ORIO-124 → ORIO-125']),
        ('The write', 'One row, plus its checklist and gates.', ['tasks.ts:138', 'INSERT INTO tasks (…) VALUES (…)']),
        ('After the reply', 'Log, metric, and a change for other tabs.', ['app.ts:205 (metrics) · app.ts:250 (change_log)']),
    ]
    col_w = 1120
    for i, (head, plain, code) in enumerate(steps):
        col, row = i // 6, i % 6
        x = 60 + col * (col_w + 100)
        yy = f.cursor + row * 132
        num = rect(x, yy + 6, 42, 42, BLUE, width=2, frame=f.id)
        txt(x + 14, yy + 13, [str(i + 1)], 20, '#2563eb', True, False, f.id)
        txt(x + 60, yy, [head], 20, INK, True, False, f.id)
        txt(x + 60, yy + 30, wrap(plain, 16, col_w - 60), 16, MUTED, False, False, f.id)
        f.codebox(x + 60, yy + 56, col_w - 60, code, f.id)
        f.place(yy + 56 + f.code_h(code, col_w - 60) + 10)
    yb = f.cursor + 6 * 132 - 8
    f.band(yb, 'If step 6 fails you get 400 and the field name. If step 8 fails you get 400 "unknown column". Nothing is half-written: the database refuses the whole statement, not the application.',
           tone=('#fef2f2', '#fca5a5'), size=17)
    y = f.finish()

    # ---------------------------------------------------------------- 04
    f = new('04 · The one file to learn first — app.ts, line by line',
            '636 lines. These thirteen are the entire request path, in the order they run.', y)
    lines = [
        (':54', 'buildApp()', 'Builds the server object. Every entrypoint calls this and nothing else.'),
        (':145', 'helmet', 'Security headers: the page cannot be framed, sniffed or hot-linked by accident.'),
        (':153', 'cors', 'Allows the API to answer other origins — needed for /api in dev, harmless in prod.'),
        (':163', 'body limit 2 MB', 'A request larger than this is rejected before it reaches a handler.'),
        (':191', 'onRequest', 'First hook. Stamps the start time and resolves identity.'),
        (':205', 'onResponse → metrics', 'Counts the request, its status and its duration (RED metrics).'),
        (':250', 'onResponse → change_log', 'Any successful write appends one row, which is what the live feed reads.'),
        (':267', 'setErrorHandler', 'One place turns any thrown error into the standard envelope.'),
        (':362', 'setNotFoundHandler', 'Unknown /api path returns JSON 404, never an HTML page.'),
        (':476', 'rate limits', '1200 / 30 / 240 requests per minute, per IP, per route class.'),
        (':493', 'operator hook', 'Attaches req.identity — the single user this deployment attributes work to.'),
        (':530', 'operator routes', 'The /api/auth/* endpoints in their own small module.'),
        (':558', 'static files', 'Serves a real apps/web/dist if one exists (dev). Lazily imported.'),
    ]
    yy = f.cursor
    for ln, what, plain in lines:
        rect(60, yy, W - 2 * M, 76, WHITE, False, 2, f.id)
        txt(84, yy + 22, [ln], 18, '#7c3aed', True, True, f.id)
        txt(200, yy + 22, [what], 18, INK, True, True, f.id)
        txt(660, yy + 24, wrap(plain, 16, 1600), 16, MUTED, False, False, f.id)
        f.place(yy + 76)
        yy += 76 + 8
    f.band(yy + 12,
           'Order is the point. The error handler is registered after the hooks so it catches their failures. Static files are imported lazily — a top-level import there is exactly what caused the outage in frame 09.',
           size=17)
    y = f.finish()

    # ---------------------------------------------------------------- 05
    f = new('05 · The database — and why bad data cannot get in',
            'The interesting part of a table is not its columns. It is what it refuses to store.', y)
    c0 = f.cursor
    ddl = ['-- db/migrations/pg/0002_work.sql',
           'CREATE TABLE tasks (',
           '  id        TEXT PRIMARY KEY,',
           '  key       TEXT NOT NULL UNIQUE,',
           '  project_id TEXT REFERENCES projects(id)',
           '            ON DELETE CASCADE,',
           '  column_id  TEXT NOT NULL',
           '            REFERENCES columns(id),',
           '  parent_id  TEXT REFERENCES tasks(id),',
           '  title      TEXT NOT NULL,',
           '  status     task_status NOT NULL',
           '            CHECK (status IN (',
           "              'backlog','todo','in_progress',",
           "              'review','blocked','done','cancelled')),",
           '  position   DOUBLE PRECISION DEFAULT 1000);']
    hddl = f.card_h(900, 'The table that is actually created', 'Read the constraints as sentences.', ddl)
    f.card(60, c0, 900, 'The table that is actually created',
           'Read the constraints as sentences: they are rules the application cannot bypass.',
           AMBER, code=ddl, code_color='#334155')
    f.card(60, c0 + hddl + 24, 900, 'Ids and timestamps are decided in code',
           'Every id is prefixed and time-sortable, so a row tells you what it is and roughly when it happened. Timestamps are stored as "YYYY-MM-DD HH:MM:SS" UTC — deliberately not ISO with a T, because a space sorts before a T and mixing the two silently reorders every comparison.',
           WHITE, code=['id("tsk")  →  tsk_m3k9x1a  + 8 random',
                        'ALPHABET = 0-9a-z minus i,l,o,u',
                        '',
                        "nowIso()  →  '2026-11-08 09:14:02'"])

    c2 = c0
    right = [
        ('CHECK (status IN (…seven…))', 'A status outside the seven allowed values is refused by the database, whatever the client sends.', ['status CHECK (status IN (…))'], WHITE),
        ('UNIQUE (board_id, key)', 'One board cannot have two columns with the same key. The database decides, not a race in the API.', ['columns: UNIQUE (board_id, key)'], WHITE),
        ('Two opposite delete rules, on purpose', 'Deleting a project takes its tasks with it (CASCADE). Deleting a client who still has projects is refused (RESTRICT).', ['tasks.project_id   → CASCADE', 'projects.client_id → RESTRICT'], WHITE),
        ('Prefixed ids, not auto-increment', 'cl_ pr_ tsk_ usr_ — an id is self-describing, and nothing leaks how many rows exist.', ["id('tsk')  ·  lib/ids.ts"], WHITE),
        ('Two schema sources — one of them inert', 'db/postgres/schema.sql calls itself "the production system of record" and carries rules the boot migrations do not, including CHECK (length(title) >= 4). Nothing applies it automatically: migrations come from db/migrations/pg at boot, and CI never runs schema.sql. The same title rule is enforced in code instead — zod .min(4) and a 4-character guard in the service.',
         ['scripts/test-pg.mjs → db/cli.ts migrate', 'db/postgres/README.md → "psql -f", by hand'], AMBER),
    ]
    for t, b, code, tone in right:
        hh = f.card_h(1340, t, b, code)
        f.card(1000, c2, 1340, t, b, tone, code=code, force_h=hh)
        c2 += hh + 14
    f.band(max(c2, c0 + hddl + 24 + f.card_h(900, 'Ids and timestamps are decided in code',
                                              'x', ['a', 'b', 'c', 'd'])) + 16,
           '81 tables are alive today, created by 83 CREATE TABLE statements — the two extra are rebuild-and-rename artefacts from the SQLite era (sessions_new, sla_timers_new), not leftovers. And the drift above is real: the code is the arbiter, so the rule that matters is the one in routes/index.ts:392 and services/tasks.ts:99.',
           size=17)
    y = f.finish()

    # ---------------------------------------------------------------- 06
    f = new('06 · The rules — what is enforced, and what is only a list',
            'This is the distinction most architecture diagrams get wrong. It is the difference between a corridor and a signpost.', y)
    c0 = f.cursor
    f.label(60, c0, 'Enforced — the server refuses the move')
    cy = c0 + 34
    for t, b, code in [
        ('Client lifecycle, 18 stages', 'A transition that is not in the table is refused with 409. Evidence rows are required for guarded moves.',
         ['services/lifecycle.ts', 'STAGE_KEYS (18) · TRANSITIONS']),
        ('Acceptance ladder, 4 steps', 'dev_complete → qa_approved → lead_approved → client_accepted. Unique per task and step.',
         ['services/tasks.ts:19', 'ACCEPTANCE_LADDER = […4…]']),
        ('Turnover gates, 8 rules', 'A task cannot be called done while a gate rule is unsatisfied.',
         ['domain/turnover.ts:77', 'AUTO_RULES = {…8 entries…}']),
        ('Ship gate', 'A release cannot ship while a required QA check is open.',
         ['services/shipgate.ts', 'evaluateShipGate()']),
        ('Deadline sweep', 'Running and past due becomes missed. Runs daily and on boot.',
         ['services/clocks.ts', 'UPDATE … WHERE outcome=\'running\'']),
    ]:
        f.card(60, cy, 1120, t, b, GREEN, code=code)
        cy += f.card_h(1120, t, b, code) + 14
    left_bottom = cy

    f.label(1240, c0, 'Only a list — nothing stops the jump')
    dy = c0 + 34
    for t, b, code in [
        ('Pipeline stages, 12', 'A deal can be PATCHed to any stage id. There is no server-side rule about which may follow which.',
         ['PIPELINE_STAGES (12)', 'PATCH /api/deals/:id  → any stage']),
        ('Task status', 'todo · doing · done is a column value, not a state machine.',
         ['status task_status NOT NULL', "DEFAULT 'todo'"]),
        ('WIP limits', 'columns.wip_limit is stored and seeded. Nothing reads it, so no column ever refuses a card because it is full.',
         ['grep -r wip_limit apps/api/src/services', '  → no results (only seed + scaffolding)']),
    ]:
        f.card(1240, dy, 1100, t, b, GREY, code=code, dashed=True)
        dy += f.card_h(1100, t, b, code) + 14
    f.card(1240, dy, 1100, 'Why say this out loud?',
           'Because a diagram showing a pipeline with arrows looks enforced, and a reader will believe it. It is a list of labels. Only the left column is code that can refuse you.',
           WHITE, code=['An earlier version of my own board got', 'this wrong. The code wins.'])
    right_bottom = dy + f.card_h(1100, 'Why say this out loud?', 'x', ['a'])
    f.band(max(left_bottom, right_bottom) + 16,
           'Plain version: a pipeline is a set of labels you can jump between. A lifecycle is a corridor with doors that only open forwards. Only the corridor is real.',
           size=18)
    y = f.finish()

    # ---------------------------------------------------------------- 07
    f = new('07 · Two real journeys, down to the statement',
            'One read, one write. Everything else in the API is a variation on these two.', y)
    c0 = f.cursor
    f.card(60, c0, 1120, 'A · Reading the project list',
           'One request, one query. The counts are correlated subqueries, so there is no N+1.',
           BLUE, code=[
               'GET /api/projects            routes/index.ts:945',
               '  SELECT p.*, c.name,',
               '    (SELECT COUNT(*) FROM tasks t',
               '      WHERE t.project_id = p.id) AS task_count,',
               '    … three more counts …',
               '  FROM projects p JOIN clients c ON …',
               'mapProject(row)   snake_case → camelCase',
               'reply   { data: [ … ] }        no meta unless ?limit'])
    f.card(60, c0 + f.last_h + 24, 1120, 'B · Creating a task',
           'Six steps, each one able to stop the write with a named reason.',
           GREEN, code=[
               '1  zod.safeParse(body)      → 400 + field name',
               '2  board must exist         → 400 unknown board',
               '3  SELECT id FROM columns',
               '     WHERE board_id=? AND key=?  → 400 no column',
               '4  nextKey()  highest suffix + 1',
               '5  INSERT tasks + checklist + gates   (tx)',
               '6  201 { data: taskDetail }'])
    f.card(1240, c0, 1100, 'What the client can rely on',
           'Every answer — success or failure — has the same outer shape. The frontend has one parser, not forty.',
           VIOLET, code=[
               '{ data: … }',
               '{ data: […], meta: { total, limit, offset } }',
               '{ error: { code, message, detail? } }',
               '',
               '400 bad input · 404 missing · 409 conflict',
               '500 anything uncaught      → setErrorHandler'])
    f.card(1240, c0 + f.last_h + 24, 1100, 'Two things that are easy to get wrong',
           'A task key comes from the highest existing number, not from COUNT(*) — the count version shipped a duplicate key and a 409 in production. And the column is looked up by (board_id, key), never by guessing an id shape.',
           ROSE, code=[
               'tasks.ts:40   nextKey()',
               '  "Derived from the highest existing suffix,',
               '   not from the row count."'])
    f.band(f.bottom + 26,
           'This is the level of detail the rest of the system keeps: a route, a query, a reason for the shape, and the bug that made it that way.',
           size=18)
    y = f.finish()

    # ---------------------------------------------------------------- 08
    f = new('08 · How it reaches production',
            'Four build steps, five runtime steps. Nothing compiles while a page is loading.', y)
    c0 = f.cursor
    f.label(60, c0, 'Build time — happens once, on Vercel, per deploy')
    by = c0 + 34
    build = [
        ('1 · Install', 'Dev dependencies included — the build needs vite and tsc.', 'npm ci --include=dev'),
        ('2 · Screens', 'Vite compiles React into static files.', 'npm run build:web:service'),
        ('3 · Embed', 'Those files become one TypeScript module.', 'scripts/embed-web-assets.mjs'),
        ('4 · Compile', 'tsc emits apps/api/dist, screens included.', 'npm run build:api'),
    ]
    hb = max(f.card_h(540, t, b, [code]) for t, b, code in build)
    for i, (t, b, code) in enumerate(build):
        f.card(60 + i * 580, by, 540, t, b, BLUE, code=[code], force_h=hb)
    f.label(60, by + hb + 40, 'Runtime — happens on every cold start')
    ry = by + hb + 74
    run = [
        ('1 · Settings', 'DATABASE_URL must exist. Missing → refuse to boot.', 'db/index.ts (throws)'),
        ('2 · Pool', 'Ten reusable connections, not one per request.', 'postgres.ts: max 10'),
        ('3 · Migrate', '17 SQL files, applied in order, checksummed.', 'db/migrate.ts'),
        ('4 · Operator', 'Ensure exactly one users row exists.', 'ensureOperator()'),
        ('5 · Listen', 'Bind PORT on 0.0.0.0 and serve.', 'entrypoints/index.ts'),
    ]
    hr = max(f.card_h(430, t, b, [code]) for t, b, code in run)
    for i, (t, b, code) in enumerate(run):
        f.card(60 + i * 462, ry, 430, t, b, GREEN, code=[code], force_h=hr)
    f.band(ry + hr + 30,
           'Why step 3 of the build exists: Vercel bundles what is imported, not what sits in a folder — and the services schema rejects includeFiles. So the SPA is compiled into the API as a module (16 assets) instead of copied next to it.',
           size=17)
    y = f.finish()

    # ---------------------------------------------------------------- 09
    f = new('09 · When it breaks — two things that really happened',
            'Not hypotheticals. Both are in the repository, with the fix and the test that stops them returning.', y)
    c0 = f.cursor
    f.card(60, c0, 1120, 'Story 1 · The database that was not there',
           'An earlier revision fell back to a file database when DATABASE_URL was missing. On a serverless host that file lives in /tmp and is deleted with the instance — so the app booted, accepted writes, read them back, and then lost them. It behaved like a database right up until the moment it did not. The fix was to refuse to start, and to say which setting is missing.',
           RED, code=['db/index.ts      throws when neither engine is', '                 configured  → 503 + setup page',
                      'lib/misconfigured.ts   human-readable reason'])
    f.card(60, c0 + f.last_h + 24, 1120, 'Story 2 · The outage with no route to report it',
           '@fastify/static was imported at the top of app.ts. Version 10.1.4 pulled in an ESM-only dependency; on a runtime without require(esm) that threw while the module was loading — before any route existed. Every request answered boot_failed, and nothing could explain why. The fix: pin 10.1.3, import inside the branch that needs it, and test it in a child process.',
           RED, code=['app.ts:558          import inside the branch',
                      'package.json        "@fastify/static": "10.1.3"',
                      'module-format.test.mjs   4 child-process cases',
                      '   --no-experimental-require-module'])
    f.card(1240, c0, 1100, 'What a failure looks like now',
           'One handler shapes every error, so a broken deployment is legible instead of blank.',
           VIOLET, code=['{ error: {', '    code: "boot_failed",',
                         '    message: "DATABASE_URL is not set…" } }',
                         '', 'Browser → a setup page naming the variable',
                         'Anything else → the same JSON envelope'])
    f.card(1240, c0 + f.last_h + 24, 1100, 'The habit behind both',
           'Every failure that actually happened became three things: a comment in the file explaining why, a test that reproduces it, and a line in the documentation. That is why the repository has an opinion about /tmp and about top-level imports.',
           GREEN, code=['Every guard in npm run verify was written', 'after something failed: module format,', 'deployment config, boot, persistence, backup.'])
    f.band(f.bottom + 26,
           'This is the part worth copying: the system is honest about how it fails, not just about what it does.',
           size=18)
    y = f.finish()

    # ---------------------------------------------------------------- 10
    f = new('10 · Security, said out loud',
            'There is no login. That is a decision, and the API says so in its own response.', y)
    c0 = f.cursor
    top10 = [
        ('What the server says about itself', 'A reader does not have to guess whether authentication is broken — the answer is a field.',
         RED, ['GET /api/auth/session', '{ authenticated: true,', '  authMode: "none",',
               '  permissions: Proxy(all → true),', '  csrfToken: null }', '',
               'POST /api/auth/login  → 410 Gone']),
        ('What is actually protecting it', 'Platform password protection on the deployment, plus these application controls.',
         GREEN, ['helmet · cors · 2 MB body limit', 'rate limit 1200 / 30 / 240 per min',
                 'parameterised SQL everywhere', 'DB constraints as invariants',
                 'CRON_SECRET compared in constant time', 'audit_log + change_log (append-only)']),
        ('What that means in practice', 'Anyone who can reach the URL can read and change everything, and every change is filed under the same person.',
         AMBER, ['identity: usr_owner (role: admin)', 'history says WHAT changed,', 'never WHO changed it']),
    ]
    h10 = max(f.card_h(740, t, b, c) for t, b, _, c in top10)
    for (t, b, tone, code), x in zip(top10, (60, 840, 1620)):
        f.card(x, c0, 740, t, b, tone, code=code, force_h=h10)
    r10 = c0 + h10 + 26
    hA = f.card_h(1500, 'RBAC exists in the schema and is never enforced',
                  'project_members, partner_iam_users and client_portal_users all exist, and scope.ts can restrict a query by membership. With a single admin operator the scope resolves to "everything", so the restriction never fires. Saying it enforces access control would be false; saying it is absent would also be false. It is present and idle.', ['apps/api/src/auth/scope.ts'])
    hB = f.card_h(760, 'What turning it on would take',
                  'Four things, none of them started: an identity provider, credentials stored per user, membership checks switched on in scope.ts, and a 403 path with tests behind it.',
                  ['✗ identity provider', '✗ credential storage', '✗ enforcement + 403 tests'])
    f.card(60, r10, 1500, 'RBAC exists in the schema and is never enforced',
           'project_members, partner_iam_users and client_portal_users all exist, and scope.ts can restrict a query by membership. With a single admin operator the scope resolves to "everything", so the restriction never fires. Saying it enforces access control would be false; saying it is absent would also be false. It is present and idle.',
           GREY, code=['apps/api/src/auth/scope.ts'], force_h=max(hA, hB))
    f.card(1600, r10, 760, 'What turning it on would take',
           'Four things, none of them started: an identity provider, credentials stored per user, membership checks switched on in scope.ts, and a 403 path with tests behind it.',
           WHITE, code=['✗ identity provider', '✗ credential storage', '✗ enforcement + 403 tests'],
           force_h=max(hA, hB))
    f.band(r10 + max(hA, hB) + 30,
           'The honest sentence: this is an internal tool behind a platform login, not a multi-tenant product. Making it multi-tenant is a schema change plus a real identity provider — neither is done.',
           size=18)

    y = f.finish()

    # ---------------------------------------------------------------- 11
    f = new('11 · Tests and CI — what "green" actually means',
            'A build proves it compiles. It does not prove it starts. Both are checked, separately.', y)
    c0 = f.cursor
    f.card(60, c0, 1120, 'npm run verify — ten gates, in order',
           'One command a person can run before pushing. It stops at the first failure.',
           BLUE, code=[
               'guard          no JSON store, SQL portable, deps declared,',
               '               migrations in sync, deployment config agrees',
               'typecheck      tsc --noEmit on both projects',
               'test           283 tests, 24 files',
               'test:pg        19 of them again on real PostgreSQL 16',
               'build:service  the production build, exactly as Vercel runs it',
               'verify:routing every API call in the frontend has a route',
               'smoke:web      Chromium drives the real app',
               'verify:boot    start the built server, call it, stop it',
               'test:persistence  restart and read the data back',
               'backup:verify  restore a dump into a fresh database'])
    f.card(1240, c0, 1100, 'Why "it built" is not "it works"',
           'A build can pass while the server never starts: a missing setting, a bad top-level import, a port that is not bound. So the pipeline builds the way production builds, then starts the artefact and calls it.',
           GREEN, code=[
               'ci.yml  ·  single-service-build job',
               '  npm ci --omit=dev        (production install)',
               '  npm run build:service',
               '  node dist/index.js → GET /api/live',
               '',
               'service-entry.test.mjs',
               'platform-launcher.test.mjs'])
    f.card(1240, c0 + f.last_h + 24, 1100, 'The four tests that exist because of an outage',
           'A child process loads the server with ESM require disabled — the runtime shape that broke in July — and asserts it still boots.',
           ROSE, code=[
               'node --no-experimental-require-module',
               '  apps/api/test/module-format.test.mjs',
               '',
               '1 loads under CJS-only conditions',
               '2 static route still serves',
               '3 no top-level ESM import',
               '4 boot failure is legible'])
    f.band(max(f.bottom, c0 + 640) + 20,
           'If you remember one line: the pipeline builds the way production builds, then starts the server and calls it. Everything else is a detail around that idea.',
           size=18)
    y = f.finish()

    # ---------------------------------------------------------------- 12
    f = new('12 · The thirty words you need',
            'No jargon goes unexplained anywhere on this page. This is the whole vocabulary.', y)
    terms = [
        ('Handler', 'The function that answers one URL.', 'app.post("/api/tasks", handler)'),
        ('Hook', 'Code that runs before or after every handler.', 'onRequest · onResponse'),
        ('Route', 'A method plus a path the server answers.', 'GET /api/projects'),
        ('Envelope', 'The wrapper every answer arrives in.', '{ data } · { error }'),
        ('Migration', 'A numbered SQL file that changes the schema.', '0001_core.sql … 0017'),
        ('Ledger', 'The table that records which migrations ran.', 'schema_migrations'),
        ('Constraint', 'A rule the database will not break.', 'CHECK · UNIQUE · FK'),
        ('Foreign key', 'A column that must match a row elsewhere.', 'tasks.project_id → projects.id'),
        ('Primary key', 'The column that identifies a row.', 'id TEXT PRIMARY KEY'),
        ('Pool', 'A small set of reused connections.', 'pg pool max 10'),
        ('Transaction', 'Several statements, all or nothing.', 'db.tx(async (t) => …)'),
        ('Cron', 'Something the platform calls on a schedule.', '0 3 * * * → /api/cron/sweep'),
        ('Idempotent', 'Running it twice changes nothing extra.', 'only rows still "running"'),
        ('Serverless', 'Started per request, not kept alive.', 'here: one long-lived process'),
        ('ORM', 'A library that writes SQL for you.', 'not used — SQL is written by hand'),
        ('RBAC', 'Permissions by role.', 'in schema, not enforced'),
        ('CORS', 'Which other sites may call the API.', 'unnecessary: same origin'),
        ('Rate limit', 'A cap on requests per minute.', '1200 / 30 / 240'),
        ('Embedded SPA', 'Screens compiled into the server build.', 'generated/web-assets.ts'),
        ('Cold start', 'The first request after the process stopped.', 'pool + migrations + listen'),
    ]
    cw = 560
    row_h = max(f.card_h(cw, t, b, [c], ts=18) for t, b, c in terms)
    for i, (term, plain, code) in enumerate(terms):
        col, row = i % 4, i // 4
        x = 60 + col * (cw + 40)
        f.card(x, f.cursor + row * (row_h + 16), cw, term, plain, WHITE,
               code=[code], force_h=row_h, ts=18)
    f.place(f.cursor + 4 * (row_h + 16) + row_h + 16)
    y = f.finish()

    # ---------------------------------------------------------------- 13
    f = new('13 · The gaps — and how to check every claim on this page',
            'Read this before repeating anything above. It is the difference between documentation and advertising.', y)
    c0 = f.cursor
    cw = 740
    gaps = [
        ('No authentication', 'Anyone with the URL is an admin. The only gate is the hosting provider\'s password screen.', RED),
        ('Nothing is sent', 'Messages and signatures are recorded, not delivered. No email, no SMS, no e-sign integration.', AMBER),
        ('One scheduled job', 'A daily sweep plus an interval. No queue, no worker, no retry ladder, no dead-letter.', AMBER),
        ('No undo', 'Two append-only logs, but no per-record history and no restore button.', AMBER),
        ('One operator', 'Every write is attributed to usr_owner, so history cannot say who did it.', AMBER),
        ('One giant route file', '3,370 lines, 94 handlers. Correct, tested, and the first thing to split.', AMBER),
    ]
    h1 = max(f.card_h(cw, t, b) for t, b, _ in gaps[:3])
    h2 = max(f.card_h(cw, t, b) for t, b, _ in gaps[3:])
    for i, (t, b, tone) in enumerate(gaps):
        col, row = i % 3, i // 3
        f.card(60 + col * (cw + 40), c0 + (0 if row == 0 else h1 + 20), cw, t, b, tone,
               force_h=h1 if row == 0 else h2)
    yg = c0 + h1 + 20 + h2 + 30
    hA = f.card_h(1120, 'How to verify this page yourself',
                  'Every claim above has a command or a file behind it. In a fresh clone:', ['a'] * 7)
    hB = f.card_h(1100, 'What is deliberately not claimed',
                  'Three things could not be observed from outside the deployment, so they are not asserted anywhere on this page.', ['a'] * 8)
    hh = max(hA, hB)
    f.card(60, yg, 1120, 'How to verify this page yourself',
           'Every claim above has a command or a file behind it. In a fresh clone:',
           BLUE, force_h=hh, code=['npm ci --include=dev',
                                   'npm run verify        # all ten gates',
                                   'npm run test:pg       # needs a real PostgreSQL',
                                   'npm run build:service # then: node apps/api/dist/index.js',
                                   '',
                                   "grep -n \"app.post('/api/tasks'\" apps/api/src/routes/index.ts",
                                   'grep -n "ACCEPTANCE_LADDER" apps/api/src/services/tasks.ts'])
    f.card(1240, yg, 1100, 'What is deliberately not claimed',
           'Three things could not be observed from outside the deployment, so they are not asserted anywhere on this page.',
           GREY, dashed=True, force_h=hh,
           code=['1 the exact Vercel runtime version',
                 '2 the production environment variables',
                 '3 the running function — the URL answers',
                 '  302 → vercel.com/login (Deployment Protection)',
                 '',
                 'The build and the deploy steps are verified.',
                 'The behaviour after deploy is not.'])
    f.band(yg + hh + 30,
           'The test of a good architecture document is not whether it makes the system look impressive. It is whether a reader who trusts it would be surprised later. Nothing on this page should surprise them.',
           size=18)
    y = f.finish(gap=20)


# =====================================================================
#  validate
# =====================================================================
def validate():
    p = []
    ids = {e['id'] for e in _el}
    if len(ids) != len(_el):
        p.append('duplicate ids')
    frames = {e['id']: e for e in _el if e['type'] == 'frame'}
    for e in _el:
        for b in e.get('boundElements') or []:
            if b['id'] not in ids:
                p.append(f"dangling boundElements {e['id']}")
        if e['type'] == 'arrow':
            for k in ('startBinding', 'endBinding'):
                if e.get(k) and e[k]['elementId'] not in ids:
                    p.append(f"dangling {k}")
        if e['type'] != 'frame' and e.get('frameId'):
            fr = frames.get(e['frameId'])
            if not fr:
                p.append(f"orphan frameId {e['id']}")
            elif not (e['y'] >= fr['y'] - 1 and e['y'] + e['height'] <= fr['y'] + fr['height'] + 1):
                p.append(f"outside frame: '{(e.get('text') or e['type'])[:40]}'")
    boxes = [(e['id'], (e['x'], e['y'], e['x'] + e['width'], e['y'] + e['height']))
             for e in _el if e['type'] == 'rectangle']
    for e in _el:
        if e['type'] != 'text' or not (e.get('text') or '').strip():
            continue
        t = (e['x'], e['y'], e['x'] + e['width'], e['y'] + e['height'])
        for bid, b in boxes:
            ix = max(0, min(t[2], b[2]) - max(t[0], b[0]))
            iy = max(0, min(t[3], b[3]) - max(t[1], b[1]))
            if ix * iy <= 300:
                continue
            if not (t[0] >= b[0] - 2 and t[1] >= b[1] - 2 and t[2] <= b[2] + 2 and t[3] <= b[3] + 2):
                p.append(f"text crosses border: '{(e.get('text') or '').splitlines()[0][:38]}'")
    rects = [e for e in _el if e['type'] == 'rectangle']
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            a = (rects[i]['x'], rects[i]['y'], rects[i]['x'] + rects[i]['width'], rects[i]['y'] + rects[i]['height'])
            b = (rects[j]['x'], rects[j]['y'], rects[j]['x'] + rects[j]['width'], rects[j]['y'] + rects[j]['height'])
            ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
            iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
            if ix * iy <= 400:
                continue
            nested = all(a[k] >= b[k] - 1 for k in (0, 1)) and all(a[k] <= b[k] + 1 for k in (2, 3))
            nest2 = all(b[k] >= a[k] - 1 for k in (0, 1)) and all(b[k] <= a[k] + 1 for k in (2, 3))
            if not nested and not nest2:
                p.append(f"panels overlap: ({rects[i]['x']:.0f},{rects[i]['y']:.0f}) vs ({rects[j]['x']:.0f},{rects[j]['y']:.0f})")
    return p


# =====================================================================
#  exports
# =====================================================================
def export_excalidraw():
    doc = {'type': 'excalidraw', 'version': 2, 'source': 'https://excalidraw.com',
           'elements': [e for e in _el if e['type'] == 'frame'] + [e for e in _el if e['type'] != 'frame'],
           'appState': {'gridSize': None, 'viewBackgroundColor': '#ffffff'}, 'files': {}}
    path = os.path.join(OUT, NAME + '.excalidraw')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    return path


def _bounds():
    xs = [e['x'] for e in _el] + [e['x'] + e['width'] for e in _el]
    ys = [e['y'] for e in _el] + [e['y'] + e['height'] for e in _el]
    return min(xs), min(ys), max(xs), max(ys)


def _esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def export_svg(pad=40):
    x0, y0, x1, y1 = _bounds()
    w, h = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" '
         f'viewBox="{x0 - pad:.0f} {y0 - pad:.0f} {w:.0f} {h:.0f}">',
         '<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" '
         'orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#94a3b8"/></marker></defs>',
         f'<rect x="{x0 - pad:.0f}" y="{y0 - pad:.0f}" width="{w:.0f}" height="{h:.0f}" fill="#fff"/>']
    for e in _el:
        t = e['type']
        if t == 'frame':
            o.append(f'<rect x="{e["x"]}" y="{e["y"]}" width="{e["width"]}" height="{e["height"]}" fill="none" stroke="#c7d2fe" stroke-width="2" rx="10"/>')
        elif t == 'rectangle':
            dash = ' stroke-dasharray="10 7"' if e['strokeStyle'] == 'dashed' else ''
            o.append(f'<rect x="{e["x"]}" y="{e["y"]}" width="{e["width"]}" height="{e["height"]}" rx="9" fill="{e["backgroundColor"]}" stroke="{e["strokeColor"]}" stroke-width="{e["strokeWidth"]}"{dash}/>')
        elif t == 'arrow':
            (sx, sy), (dx, dy) = e['points']
            o.append(f'<line x1="{e["x"]}" y1="{e["y"]}" x2="{e["x"] + dx}" y2="{e["y"] + dy}" stroke="{e["strokeColor"]}" stroke-width="2" marker-end="url(#a)"/>')
        elif t == 'text':
            fam = 'DejaVu Sans Mono, monospace' if _mono.get(e['id']) else 'DejaVu Sans, Helvetica, Arial, sans-serif'
            wt = '700' if _bold.get(e['id']) else '400'
            lh = e['lineHeight']
            for i, line in enumerate(e['text'].split('\n')):
                o.append(f'<text x="{e["x"]:.1f}" y="{e["y"] + (i + 0.92) * e["fontSize"] * lh:.1f}" '
                         f'font-family="{fam}" font-size="{e["fontSize"]}" font-weight="{wt}" '
                         f'fill="{e["strokeColor"]}">{_esc(line)}</text>')
    o.append('</svg>')
    path = os.path.join(OUT, NAME + '.svg')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(o))
    return path


def _dashes(d, p1, p2, color, width, dash, gap):
    x1, y1 = p1
    x2, y2 = p2
    total = math.hypot(x2 - x1, y2 - y1)
    if total <= 0:
        return
    ux, uy = (x2 - x1) / total, (y2 - y1) / total
    pos = 0.0
    while pos < total:
        end = min(pos + dash, total)
        d.line([(x1 + ux * pos, y1 + uy * pos), (x1 + ux * end, y1 + uy * end)], fill=color, width=width)
        pos = end + gap


def export_png(pad=40, scale=1.0):
    # 14 frames make this a very tall board: at scale 1.0 the raster is already
    # ~100 megapixels. The SVG is the crisp artefact; the PNG is the preview.
    if Image is None:
        return None
    Image.MAX_IMAGE_PIXELS = None
    x0, y0, x1, y1 = _bounds()
    Wp, Hp = int((x1 - x0 + 2 * pad) * scale), int((y1 - y0 + 2 * pad) * scale)
    im = Image.new('RGB', (Wp, Hp), '#ffffff')
    d = ImageDraw.Draw(im)
    S = lambda v: (v - (x0 - pad)) * scale
    T = lambda v: (v - (y0 - pad)) * scale
    for e in _el:
        t = e['type']
        if t == 'frame':
            d.rounded_rectangle([S(e['x']), T(e['y']), S(e['x'] + e['width']), T(e['y'] + e['height'])],
                                radius=10 * scale, outline='#dbeafe', width=max(1, int(2 * scale)))
        elif t == 'rectangle':
            xy = [S(e['x']), T(e['y']), S(e['x'] + e['width']), T(e['y'] + e['height'])]
            wdt = max(1, int(e['strokeWidth'] * scale))
            if e['strokeStyle'] == 'dashed':
                d.rounded_rectangle(xy, radius=9 * scale, fill=e['backgroundColor'])
                for p1, p2 in (((xy[0] + 9 * scale, xy[1]), (xy[2] - 9 * scale, xy[1])),
                               ((xy[2], xy[1] + 9 * scale), (xy[2], xy[3] - 9 * scale)),
                               ((xy[2] - 9 * scale, xy[3]), (xy[0] + 9 * scale, xy[3])),
                               ((xy[0], xy[3] - 9 * scale), (xy[0], xy[1] + 9 * scale))):
                    _dashes(d, p1, p2, e['strokeColor'], wdt, 12 * scale, 8 * scale)
            else:
                d.rounded_rectangle(xy, radius=9 * scale, fill=e['backgroundColor'],
                                    outline=e['strokeColor'], width=wdt)
        elif t == 'arrow':
            (sx, sy), (dx, dy) = e['points']
            p1, p2 = (S(e['x']), T(e['y'])), (S(e['x'] + dx), T(e['y'] + dy))
            d.line([p1, p2], fill=e['strokeColor'], width=max(1, int(2 * scale)))
            ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
            L = 11 * scale
            for s in (0.45, -0.45):
                d.line([p2, (p2[0] - L * math.cos(ang - s), p2[1] - L * math.sin(ang - s))],
                       fill=e['strokeColor'], width=max(1, int(2 * scale)))
        elif t == 'text':
            size = int(round(e['fontSize'] * scale))
            kind = 'm' if _mono.get(e['id']) else ('b' if _bold.get(e['id']) else 'r')
            fnt = ImageFont.truetype({'r': FONT_R, 'b': FONT_B, 'm': FONT_M}[kind], size)
            for i, line in enumerate(e['text'].split('\n')):
                d.text((S(e['x']), T(e['y'] + i * e['fontSize'] * e['lineHeight'])), line,
                       font=fnt, fill=e['strokeColor'])
    im = im.quantize(colors=256, dither=Image.NONE)
    path = os.path.join(OUT, NAME + '.png')
    im.save(path, optimize=True)
    return path


if __name__ == '__main__':
    build()
    probs = validate()
    n = {k: sum(1 for e in _el if e['type'] == k) for k in ('frame', 'rectangle', 'text', 'arrow')}
    print(f"elements {len(_el)}  frames {n['frame']}  rect {n['rectangle']}  text {n['text']}  arrow {n['arrow']}")
    print('problems:', len(probs))
    for x in probs[:25]:
        print('  -', x)
    print(export_excalidraw())
    print(export_svg())
    print(export_png())
    sys.exit(1 if probs else 0)
