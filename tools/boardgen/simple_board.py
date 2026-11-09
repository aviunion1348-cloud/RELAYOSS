#!/usr/bin/env python3
"""
Generator for docs/architecture/RELAYOS_EXPLAINED_SIMPLY.{excalidraw,svg,png}

One writer, three artefacts, so the editable scene and the exported pictures can
never disagree. No external assets: every element is a native Excalidraw
rectangle, text line or arrow.

Run:  python3 tools/boardgen/simple_board.py
"""
from __future__ import annotations
import base64, io, json, math, os, random, sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # rendering is optional; the .excalidraw is the deliverable
    Image = ImageDraw = ImageFont = None

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'docs', 'architecture'))
NAME = 'RELAYOS_EXPLAINED_SIMPLY'

FONT_DIR = '/usr/share/fonts/truetype/dejavu'
FONT_R = os.path.join(FONT_DIR, 'DejaVuSans.ttf')
FONT_B = os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')

# ---------------------------------------------------------------- palette
INK     = '#1f2937'
MUTED   = '#475569'
FAINT   = '#94a3b8'
BLUE    = ('#eff6ff', '#2563eb')
GREEN   = ('#ecfdf5', '#059669')
AMBER   = ('#fffbeb', '#d97706')
VIOLET  = ('#f5f3ff', '#7c3aed')
ROSE    = ('#fff1f2', '#e11d48')
GREY    = ('#f8fafc', '#94a3b8')
RED     = ('#fef2f2', '#dc2626')
WHITE   = ('#ffffff', '#cbd5e1')

W = 2400          # frame width
M = 60            # frame inner left margin
BODY = 17         # body font size
LH = 1.25         # Excalidraw line height

_rng = random.Random(20261108)
_elements: list[dict] = []
_geom: dict[str, tuple] = {}      # id -> (x, y, w, h) for arrow geometry
_by_name: dict[str, str] = {}     # label -> id
_bold: dict[str, bool] = {}        # id -> bold, for the exporters


# ---------------------------------------------------------------- font metrics
_fc: dict[tuple, object] = {}

def _font(size: int, bold: bool):
    if ImageFont is None:
        return None
    k = (size, bold)
    if k not in _fc:
        _fc[k] = ImageFont.truetype(FONT_B if bold else FONT_R, size)
    return _fc[k]


def measure(s: str, size: int, bold: bool = False) -> float:
    f = _font(size, bold)
    if f is not None:
        return f.getlength(s)
    return len(s) * size * 0.55        # fallback: generous


def wrap(s: str, size: int, maxw: float, bold: bool = False) -> list[str]:
    out, cur = [], ''
    for w in s.split():
        t = (cur + ' ' + w).strip()
        if not cur or measure(t, size, bold) <= maxw:
            cur = t
        else:
            out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out


# ---------------------------------------------------------------- element model
def _id(prefix: str) -> str:
    return prefix + base64.b32encode(_rng.getrandbits(64).to_bytes(8, 'big')).decode().rstrip('=').lower()[:14]


def _base(t: str, x, y, w, h, stroke, fill='transparent', dashed=False,
          width=2, radius=True, frame=None):
    e = {
        'id': _id(t[:2]),
        'type': t,
        'x': round(x, 2), 'y': round(y, 2),
        'width': round(w, 2), 'height': round(h, 2),
        'angle': 0,
        'strokeColor': stroke,
        'backgroundColor': fill,
        'fillStyle': 'solid',
        'strokeWidth': width,
        'strokeStyle': 'dashed' if dashed else 'solid',
        'roughness': 0,
        'opacity': 100,
        'groupIds': [],
        'frameId': frame,
        'roundness': {'type': 3} if radius else None,
        'seed': _rng.getrandbits(31),
        'version': 1,
        'versionNonce': _rng.getrandbits(31),
        'isDeleted': False,
        'boundElements': [],
        'updated': 1762000000000,
        'link': None,
        'locked': False,
    }
    _elements.append(e)
    _geom[e['id']] = (x, y, w, h) if t == 'rectangle' else _geom.get(e['id'])
    return e


def rect(x, y, w, h, tone=WHITE, dashed=False, width=2, frame=None):
    fill, stroke = tone
    return _base('rectangle', x, y, w, h, stroke, fill, dashed, width, True, frame)


def text_lines(x, y, lines, size=BODY, color=INK, bold=False, frame=None,
               align='left', line_height=LH):
    """One Excalidraw text element holding several lines — editable as a block."""
    s = '\n'.join(lines)
    w = max(measure(l, size, bold) for l in lines) if lines else 1
    h = len(lines) * size * line_height
    e = _base('text', x, y, w, h, color, 'transparent', False, 1, False, frame)
    _bold[e['id']] = bold
    e.update({
        'text': s, 'originalText': s,
        'fontSize': size, 'fontFamily': 2,
        'textAlign': align, 'verticalAlign': 'top',
        'lineHeight': line_height,
        'containerId': None, 'autoResize': True,
    })
    return e


def para(x, y, s, size=BODY, color=INK, bold=False, maxw=900, frame=None,
         line_height=LH):
    lines = wrap(s, size, maxw, bold)
    text_lines(x, y, lines, size, color, bold, frame, line_height=line_height)
    return len(lines) * size * line_height


def arrow(a: str, b: str, side='right', label=None, dash=False, color='#64748b',
          label_dy=0):
    ax, ay, aw, ah = _geom[a]
    bx, by, bw, bh = _geom[b]
    if side == 'right':
        sx, sy, ex, ey = ax + aw, ay + ah / 2, bx, by + bh / 2
    elif side == 'left':
        sx, sy, ex, ey = ax, ay + ah / 2, bx + bw, by + bh / 2
    elif side == 'down':
        sx, sy, ex, ey = ax + aw / 2, ay + ah, bx + bw / 2, by
    else:  # up
        sx, sy, ex, ey = ax + aw / 2, ay, bx + bw / 2, by + bh
    e = _base('arrow', sx, sy, abs(ex - sx), abs(ey - sy), color, 'transparent',
              dash, 2, False, None)
    e.update({
        'points': [[0, 0], [round(ex - sx, 2), round(ey - sy, 2)]],
        'lastCommittedPoint': None,
        'startBinding': {'elementId': a, 'focus': 0, 'gap': 8},
        'endBinding': {'elementId': b, 'focus': 0, 'gap': 8},
        'startArrowhead': None, 'endArrowhead': 'arrow',
        'elbowed': False,
    })
    for end, eid in ((a, a), (b, b)):
        for el in _elements:
            if el['id'] == eid:
                el['boundElements'].append({'type': 'arrow', 'id': e['id']})
                break
    if label:
        lw = measure(label, 16) + 22
        lx = (sx + ex) / 2 - lw / 2
        ly = (sy + ey) / 2 - 14 + label_dy
        r = rect(lx, ly, lw, 28, WHITE, width=1)
        r['backgroundColor'] = '#ffffff'
        text_lines(lx + 11, ly + 6, [label], 16, MUTED)


# ---------------------------------------------------------------- frames
class Frame:
    def __init__(self, name, title, subtitle, y, height=None):
        self.name, self.title, self.subtitle = name, title, subtitle
        self.x, self.y = 0, y
        self.cursor = y + 132
        self.bottom = self.cursor
        self.e = _base('frame', 0, y, W, height or 900, '#93c5fd', 'transparent',
                       False, 1, False, None)
        self.e.update({'name': title, 'type': 'frame'})
        text_lines(24, y + 26, [title], 40, INK, True, frame=self.e['id'])
        text_lines(26, y + 82, [subtitle], 18, MUTED, False, frame=self.e['id'])
        self.bottom = self.cursor

    def place(self, y_used_bottom):
        self.bottom = max(self.bottom, y_used_bottom)

    def card_height(self, w, title, body, title_size=23, body_size=BODY, tag=None):
        pad = 24
        inner = w - 2 * pad
        th = (title_size * LH) if title else 0
        lines = wrap(body, body_size, inner) if body else []
        bh = len(lines) * body_size * LH
        tag_h = 26 if tag else 0
        return pad + tag_h + (th + 10 if lines else 0) + bh + pad

    def card(self, x, y, w, title, body, tone=WHITE, dashed=False, title_size=23,
             body_size=BODY, tag=None, force_h=None):
        pad = 24
        inner = w - 2 * pad
        th = (title_size * LH) if title else 0
        lines = wrap(body, body_size, inner) if body else []
        bh = len(lines) * body_size * LH
        tag_h = 0
        if tag:
            tag_h = 26
        h = force_h or self.card_height(w, title, body, title_size, body_size, tag)
        r = rect(x, y, w, h, tone, dashed, 2, self.e['id'])
        cy = y + pad
        if tag:
            tw = measure(tag, 15, True) + 26
            t = rect(x + pad, cy, tw, 26, WHITE, width=1, frame=self.e['id'])
            t['backgroundColor'] = '#ffffff'
            text_lines(x + pad + 13, cy + 5, [tag], 15, tone[1], True, self.e['id'])
            cy += 26 + 8
        if title:
            text_lines(x + pad, cy, [title], title_size, INK, True, self.e['id'])
        if lines:
            text_lines(x + pad, cy + th + 10, lines, body_size, MUTED, False, self.e['id'])
        self.place(y + h)
        return r['id'], h

    def chip(self, x, y, label, tone, dashed=False):
        padx, h, fs = 14, 32, 15
        w = measure(label, fs) + 2 * padx
        r = rect(x, y, w, h, tone, dashed, 2, self.e['id'])
        text_lines(x + padx, y + (h - fs * LH) / 2 + 1, [label], fs, INK, False, self.e['id'])
        self.place(y + h)
        return r['id'], w

    def band(self, y, s, tone=WHITE, size=BODY, bold=False, height=None):
        pad = 24
        lines = wrap(s, size, W - 2 * M - 2 * pad, bold)
        h = height or (len(lines) * size * LH + 2 * pad)
        rect(M, y, W - 2 * M, h, tone, False, 2, self.e['id'])
        text_lines(M + pad, y + pad, lines, size, INK if bold else MUTED, bold, self.e['id'])
        self.place(y + h)
        return h

    def finish(self, gap_below=120):
        h = math.ceil(self.bottom - self.y + 34)
        self.e['height'] = round(h, 2)
        return self.y + h + gap_below


def new_frame(name, title, subtitle, y):
    f = Frame(name, title, subtitle, y)
    return f, f.e['id']


# ---------------------------------------------------------------- content
FEATURES = [
    ('Dashboard', 'Today at a glance: what is late, what is due this week, and what is waiting on a client.', ROSE),
    ('Clients', 'Every studio client, the contracts behind them, and how far along the relationship is.', BLUE),
    ('Projects', 'A body of work with phases, a board of columns, a budget, and the tasks inside each column.', BLUE),
    ('Tasks', 'Create a task, give it an owner and a due date, attach a checklist, and record approvals step by step.', GREEN),
    ('QA and releases', 'A checklist that must pass before a release ships. The server refuses the ship while any check is open.', GREEN),
    ('Contracts and clocks', 'Contract value and hours, plus timers that flag a deadline as close, met, or missed.', AMBER),
]

STEPS = [
    ('You click Save', 'The button sends the form to the server as one request.'),
    ('The screen asks the server', 'It calls /api/tasks on the same website it was loaded from. No second address, nothing to configure.'),
    ('The server checks the form', 'A missing or wrong field stops here and comes back named. Nothing is stored.'),
    ('The rules check it is allowed', 'Is that column real? Is this the next approval step? If not, the server refuses.'),
    ('The database stores it', 'The database keeps its own guards too, so even a buggy script cannot write nonsense.'),
    ('The screen updates', 'The list refreshes and the new row appears. Other open tabs catch up within seconds.'),
]

BETTER = [
    ('Two apps to deploy, with addresses, CORS and environment variables kept in sync',
     'One program serves the screens and the data, and the screens call /api on their own address',
     'No wiring to break between them: one URL, one deploy, nothing to keep in step'),
    ('Rules only in application code, so one stray script can write bad data',
     'The database also refuses impossible rows with its own constraints',
     'Bad data cannot get in, even while the code has a bug'),
    ('Falls back to a temporary database when the real one is missing',
     'Refuses to start, and names the setting that is missing',
     'You find out in ten seconds instead of after losing a day of work'),
    ('A green build is treated as a working deployment',
     'The build pipeline builds exactly like production, then starts the server and calls it',
     'The failures a build cannot see get caught before anyone relies on them'),
    ('A screen shows "approved" and everyone believes it',
     'Approvals are rows the server checks before it lets work move on',
     'No green tick without a record behind it'),
    ('Docs written once, wrong within a month',
     'Every claim on this page names the file it comes from',
     'You can check it yourself instead of trusting it'),
]

GAPS = [
    ('No login — by choice', 'Anyone with the link can read and change everything. The only gate is the hosting provider\'s password screen. This was a deliberate decision, not an oversight.', RED),
    ('Nothing is actually sent', 'It records that a message or a signature happened. It does not send email, texts, or documents.', AMBER),
    ('One scheduled job, no queue', 'A single daily sweep marks overdue timers as missed. There is no worker, retry queue, or broker.', AMBER),
    ('No undo', 'Two append-only history tables exist, but there is no undo button and no per-record version history.', AMBER),
    ('One user for everyone', 'Every change is filed under the same person, so history says what changed, not who changed it.', AMBER),
]


def build():
    y = 0

    # ---- 00 -----------------------------------------------------------
    f, fid = new_frame('00', 'Start here — what is RelayOS?',
                       'A back office for a design studio. One website, one program, one database. Read it top to bottom.', y)
    top = f.cursor
    f.card(60, top, 720, 'In one sentence',
           'RelayOS is where a studio keeps its clients, its projects, the tasks inside those projects, and the deadlines that are about to slip — in one place the whole team shares.', BLUE)
    f.card(840, top, 720, 'What makes it unusual',
           'It is one program, not five. The screens and the server ship together as a single thing, so there is nothing to wire up between them.', GREEN)
    f.card(1620, top, 720, 'Why you can trust this page',
           'Every box names a file in the repository. If any claim here were wrong, you could open that file and see it.', VIOLET)

    y2 = f.bottom + 56
    text_lines(60, y2, ['How to read the boxes'], 20, INK, True, fid)
    cx, cy = 60, y2 + 42
    for label, tone, dash in (('solid = exists and works today', WHITE, False),
                              ('dashed = only sometimes, or not yet', WHITE, True),
                              ('grey = someone else\'s system', GREY, False),
                              ('red = an honest gap', RED, False)):
        _, w = f.chip(cx, cy, label, tone, dash)
        cx += w + 18

    y3 = cy + 32 + 34
    f.band(y3, 'One line to remember: one program, one database, and the important rules written down twice — in the code that runs, and in the database that stores.',
           tone=('#f0f9ff', '#0284c7'), size=19, bold=False)
    y = f.finish()

    # ---- 01 -----------------------------------------------------------
    f, fid = new_frame('01', 'What you can actually do with it',
                       'Six screens of real work. None of it is a mock-up.', y)
    x0, wcard, gap = 60, 740, 40
    rows = [FEATURES[:3], FEATURES[3:]]
    yy = f.cursor
    for row in rows:
        hmax = max(f.card_height(wcard, t, b) for t, b, _ in row)
        for i, (t, b, tone) in enumerate(row):
            f.card(x0 + i * (wcard + gap), yy, wcard, t, b, tone, force_h=hmax)
        yy += hmax + 26
    f.band(yy + 6, 'Everything here is read and written through the same server, so a number you see on one screen is the same number every other screen sees.',
           tone=('#f8fafc', '#cbd5e1'), size=17)
    y = f.finish()

    # ---- 02 -----------------------------------------------------------
    f, fid = new_frame('02', 'What happens when you click a button',
                       'Six steps, roughly forty milliseconds. This is the whole round trip.', y)
    yy = f.cursor
    ids = []
    for i, (head, body) in enumerate(STEPS):
        blines = wrap(body, BODY, 1300)
        h = max(88, 30 + len(blines) * BODY * LH + 20)
        box = rect(60, yy, 1560, h, WHITE, width=2, frame=fid)
        num = rect(88, yy + (h - 54) / 2, 54, 54, BLUE, width=2, frame=fid)
        text_lines(88 + 18, yy + (h - 54) / 2 + 12, [str(i + 1)], 24, '#2563eb', True, fid)
        text_lines(170, yy + 14, [head], 22, INK, True, fid)
        text_lines(170, yy + 14 + 30, blines, BODY, MUTED, False, fid)
        ids.append(box['id'])
        yy += h + 40
    for a, b in zip(ids, ids[1:]):
        arrow(a, b, 'down', color='#cbd5e1')
    f.place(yy)
    f.card(1680, f.cursor, 660, 'If something goes wrong',
           'You get a sentence you can act on - "title is too short", "that column does not exist" - not a blank screen and not a bare 500.', RED)
    f.card(1680, f.cursor + 200, 660, 'How big is it, really',
           'One page load is one database query. A save is two or three. Nothing waits in a queue in between.', VIOLET)
    f.card(1680, f.cursor + 400, 660, 'What you never have to do',
           'No cache to clear, no worker to restart, no second server to keep in step with the first.', BLUE)
    f.place(f.cursor + 400 + 200)
    y = f.finish()

    # ---- 03 -----------------------------------------------------------
    f, fid = new_frame('03', 'Where everything lives',
                       'Five places. Learning these five is enough to find any behaviour in the system.', y)
    PLACES = [
        ('The screens', 'apps/web/src', 'React. Thirteen pages. Every call goes through one file: lib/api.ts.', BLUE),
        ('The server', 'apps/api/src', 'Fastify. About a hundred endpoints, all in routes/index.ts.', GREEN),
        ('The rules', 'services/ · domain/', 'What is allowed to happen next: approvals, lifecycles, deadline timers.', VIOLET),
        ('The memory', 'db/migrations', 'Seventeen numbered SQL files that rebuild the database, in order, at start-up.', AMBER),
        ('The build', 'scripts/build-service.mjs', 'One command turns screens plus server into one deployable thing.', ROSE),
    ]
    x0, wcard, gap = 60, 740, 40
    yy = f.cursor
    hrow1 = max(f.card_height(wcard, t, body, tag=path) for t, path, body, _ in PLACES[:3])
    for i, (t, path, body, tone) in enumerate(PLACES[:3]):
        f.card(x0 + i * (wcard + gap), yy, wcard, t, body, tone, tag=path, force_h=hrow1)
    yy += hrow1 + 26
    wide = wcard * 2 + gap
    hrow2 = max(f.card_height(wcard, PLACES[3][0], PLACES[3][2], tag=PLACES[3][1]),
                f.card_height(wide, PLACES[4][0], PLACES[4][2], tag=PLACES[4][1]))
    f.card(x0, yy, wcard, PLACES[3][0], PLACES[3][2], PLACES[3][3], tag=PLACES[3][1], force_h=hrow2)
    f.card(x0 + wcard + gap, yy, wide, PLACES[4][0], PLACES[4][2], PLACES[4][3],
           tag=PLACES[4][1], force_h=hrow2)
    yy += hrow2 + 30
    f.band(yy + 6, 'Why the split matters: a wrong number on a screen is the server or the SQL; a wrong message is the screens; a refused save is the rules. You always know where to look.',
           tone=('#f0fdf4', '#86efac'), size=18)
    y = f.finish()

    # ---- 04 -----------------------------------------------------------
    f, fid = new_frame('04', 'What the system remembers',
                       'Six kinds of row. Everything else in the database hangs off these.', y)
    yy = f.cursor
    chain = [('Clients', 'A company you work for. One client can have many projects.', BLUE),
             ('Projects', 'A body of work: phases, a board, a budget, and the client it belongs to.', BLUE),
             ('Tasks', 'One job, sitting in a column of a board, with an owner and a due date.', GREEN)]
    hrow = max(f.card_height(480, t, b) for t, b, _ in chain)
    a1 = f.card(60, yy, 480, chain[0][0], chain[0][1], BLUE, force_h=hrow)[0]
    a2 = f.card(720, yy, 480, chain[1][0], chain[1][1], BLUE, force_h=hrow)[0]
    a3 = f.card(1380, yy, 480, chain[2][0], chain[2][1], GREEN, force_h=hrow)[0]
    a4 = f.card(1380, yy + hrow + 60, 480, 'Checks',
                'Turnover gates and approval steps. A task is not done until they pass.', GREEN)[0]
    h4 = f.card_height(480, 'Checks', 'Turnover gates and approval steps. A task is not done until they pass.')
    arrow(a1, a2, 'right', 'one to many')
    arrow(a2, a3, 'right', 'one to many')
    arrow(a3, a4, 'down', 'per task')
    side_y = yy + hrow + 60 + h4 + 96
    text_lines(60, side_y - 34, ['Two more kinds of row, and two deliberate exceptions'], 20, INK, True, fid)
    f.card(60, side_y, 480, 'Users', 'Who did it. Today there is exactly one person, and no password.', VIOLET)
    f.card(720, side_y, 480, 'Clocks', 'Deadlines: running, paused, met, missed. Swept once a day.', AMBER)
    f.card(1380, side_y, 480, 'Two things are deliberately loose',
           'A deadline timer can point at a deal, a project, a task or a release, so it is not tied to one table. A QA report outlives the release it tested.', GREY)
    y = f.finish()

    # ---- 05 -----------------------------------------------------------
    f, fid = new_frame('05', 'What this does better than the usual way',
                       'Six choices, each with the problem it removes. No benchmarks — just cause and effect.', y)
    yy = f.cursor
    heads = [('The usual way', GREY), ('How RelayOS does it', GREEN), ('What it saves you', BLUE)]
    xs = [60, 740, 1420]
    for i, (label, tone) in enumerate(heads):
        r = rect(xs[i], yy, 660, 44, tone, width=2, frame=fid)
        text_lines(xs[i] + 20, yy + 12, [label], 18, tone[1], True, fid)
    yy += 44 + 18
    for usual, here, saves in BETTER:
        cells = (usual, here, saves)
        hmax = max(f.card_height(660, '', c, body_size=17) for c in cells)
        for i, (c, tone) in enumerate(zip(cells, (GREY, GREEN, BLUE))):
            f.card(xs[i], yy, 660, '', c, tone, body_size=17, force_h=hmax)
        yy += hmax + 16
    y = f.finish()

    # ---- 06 -----------------------------------------------------------
    f, fid = new_frame('06', 'What it does not do yet — honestly',
                       'Read this before you show it to anyone. None of it is hidden anywhere else.', y)
    yy = f.cursor
    x0, wcard, gap = 60, 740, 40
    wide = wcard * 2 + gap
    h1 = max(f.card_height(wcard, t, b) for t, b, _ in GAPS[:3])
    for i, (t, b, tone) in enumerate(GAPS[:3]):
        f.card(x0 + i * (wcard + gap), yy, wcard, t, b, tone, force_h=h1)
    yy += h1 + 26
    h2 = max(f.card_height(wcard, GAPS[3][0], GAPS[3][1]),
             f.card_height(wide, GAPS[4][0], GAPS[4][1]))
    f.card(x0, yy, wcard, GAPS[3][0], GAPS[3][1], GAPS[3][2], force_h=h2)
    f.card(x0 + wcard + gap, yy, wide, GAPS[4][0], GAPS[4][1], GAPS[4][2], force_h=h2)
    yy += h2 + 26
    f.band(yy + 6, 'If you remember one thing: this is one program with one database, and the rules that matter are enforced by the database itself — so it stays small, and it is hard to break.',
           tone=('#f0f9ff', '#0284c7'), size=19)
    y = f.finish(gap_below=0)


def validate():
    problems = []
    ids = {e['id'] for e in _elements}
    if len(ids) != len(_elements):
        problems.append('duplicate ids')
    frames = {e['id']: e for e in _elements if e['type'] == 'frame'}
    for e in _elements:
        for b in e.get('boundElements') or []:
            if b['id'] not in ids:
                problems.append(f"dangling boundElements {e['id']} -> {b['id']}")
        if e['type'] == 'arrow':
            for k in ('startBinding', 'endBinding'):
                if e.get(k) and e[k]['elementId'] not in ids:
                    problems.append(f"dangling {k} on {e['id']}")
        if e['type'] != 'frame' and e.get('frameId') and e['frameId'] not in frames:
            problems.append(f"orphan frameId on {e['id']}")
        if e['type'] != 'frame' and e.get('frameId'):
            fr = frames[e['frameId']]
            if not (e['y'] >= fr['y'] - 1 and e['y'] + e['height'] <= fr['y'] + fr['height'] + 1):
                problems.append(f"outside frame: {e['type']} '{(e.get('text') or '')[:30]}'")
    # text overlapping a box it does not sit inside
    boxes = [(e['id'], (e['x'], e['y'], e['x'] + e['width'], e['y'] + e['height']))
             for e in _elements if e['type'] == 'rectangle']
    for e in _elements:
        if e['type'] != 'text' or not (e.get('text') or '').strip():
            continue
        t = (e['x'], e['y'], e['x'] + e['width'], e['y'] + e['height'])
        for bid, b in boxes:
            ix = max(0, min(t[2], b[2]) - max(t[0], b[0]))
            iy = max(0, min(t[3], b[3]) - max(t[1], b[1]))
            if ix * iy <= 300:
                continue
            inside = t[0] >= b[0] - 2 and t[1] >= b[1] - 2 and t[2] <= b[2] + 2 and t[3] <= b[3] + 2
            if not inside:
                problems.append(f"text crosses box border: '{(e.get('text') or '').splitlines()[0][:40]}'")
    return problems


# ---------------------------------------------------------------- exports
def export_excalidraw():
    frames = [e for e in _elements if e['type'] == 'frame']
    rest = [e for e in _elements if e['type'] != 'frame']
    doc = {
        'type': 'excalidraw',
        'version': 2,
        'source': 'https://excalidraw.com',
        'elements': frames + rest,
        'appState': {'gridSize': None, 'viewBackgroundColor': '#ffffff'},
        'files': {},
    }
    path = os.path.join(OUT, NAME + '.excalidraw')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    return path


def _bounds():
    xs = [e['x'] for e in _elements] + [e['x'] + e['width'] for e in _elements]
    ys = [e['y'] for e in _elements] + [e['y'] + e['height'] for e in _elements]
    return min(xs), min(ys), max(xs), max(ys)


def export_svg(pad=40):
    x0, y0, x1, y1 = _bounds()
    w, h = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" '
           f'viewBox="{x0 - pad:.0f} {y0 - pad:.0f} {w:.0f} {h:.0f}">',
           f'<rect x="{x0 - pad:.0f}" y="{y0 - pad:.0f}" width="{w:.0f}" height="{h:.0f}" fill="#ffffff"/>']
    for e in _elements:
        t = e['type']
        if t == 'frame':
            out.append(f'<rect x="{e["x"]}" y="{e["y"]}" width="{e["width"]}" height="{e["height"]}" '
                       f'fill="none" stroke="#c7d2fe" stroke-width="2" rx="10"/>')
        elif t == 'rectangle':
            dash = ' stroke-dasharray="10 7"' if e['strokeStyle'] == 'dashed' else ''
            fill = e['backgroundColor']
            out.append(f'<rect x="{e["x"]}" y="{e["y"]}" width="{e["width"]}" height="{e["height"]}" '
                       f'rx="10" fill="{fill}" stroke="{e["strokeColor"]}" stroke-width="{e["strokeWidth"]}"{dash}/>')
        elif t == 'arrow':
            (sx, sy), (dx, dy) = e['points']
            ex, ey = e['x'] + dx, e['y'] + dy
            dash = ' stroke-dasharray="8 6"' if e['strokeStyle'] == 'dashed' else ''
            out.append(f'<line x1="{e["x"]}" y1="{e["y"]}" x2="{ex}" y2="{ey}" stroke="{e["strokeColor"]}" '
                       f'stroke-width="2"{dash} marker-end="url(#a)"/>')
        elif t == 'text':
            size = e['fontSize']
            weight = '700' if _bold.get(e['id']) else '400'
            for i, line in enumerate(e['text'].split('\n')):
                out.append(f'<text x="{e["x"]:.1f}" y="{e["y"] + (i + 0.92) * size * e["lineHeight"]:.1f}" '
                           f'font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="{size}" '
                           f'font-weight="{weight}" fill="{e["strokeColor"]}">{_esc(line)}</text>')
    out.insert(1, '<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" '
                  'orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#94a3b8"/></marker></defs>')
    out.append('</svg>')
    path = os.path.join(OUT, NAME + '.svg')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out))
    return path


def _esc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


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
        d.line([(x1 + ux * pos, y1 + uy * pos), (x1 + ux * end, y1 + uy * end)],
               fill=color, width=width)
        pos = end + gap


def export_png(pad=40, scale=2.0):
    if Image is None:
        return None
    x0, y0, x1, y1 = _bounds()
    Wp, Hp = int((x1 - x0 + 2 * pad) * scale), int((y1 - y0 + 2 * pad) * scale)
    im = Image.new('RGB', (Wp, Hp), '#ffffff')
    d = ImageDraw.Draw(im)

    def S(v):
        return (v - (x0 - pad)) * scale

    def T(v):
        return (v - (y0 - pad)) * scale

    for e in _elements:
        t = e['type']
        if t == 'frame':
            d.rounded_rectangle([S(e['x']), T(e['y']), S(e['x'] + e['width']), T(e['y'] + e['height'])],
                                radius=10 * scale, outline='#dbeafe', width=max(1, int(2 * scale)))
        elif t == 'rectangle':
            xy = [S(e['x']), T(e['y']), S(e['x'] + e['width']), T(e['y'] + e['height'])]
            wdt = max(1, int(e['strokeWidth'] * scale))
            if e['strokeStyle'] == 'dashed':
                d.rounded_rectangle(xy, radius=10 * scale, fill=e['backgroundColor'])
                for p1, p2 in (((xy[0] + 10 * scale, xy[1]), (xy[2] - 10 * scale, xy[1])),
                               ((xy[2], xy[1] + 10 * scale), (xy[2], xy[3] - 10 * scale)),
                               ((xy[2] - 10 * scale, xy[3]), (xy[0] + 10 * scale, xy[3])),
                               ((xy[0], xy[3] - 10 * scale), (xy[0], xy[1] + 10 * scale))):
                    _dashes(d, p1, p2, e['strokeColor'], wdt, 12 * scale, 8 * scale)
            else:
                d.rounded_rectangle(xy, radius=10 * scale, fill=e['backgroundColor'],
                                    outline=e['strokeColor'], width=wdt)
        elif t == 'arrow':
            (sx, sy), (dx, dy) = e['points']
            p1 = (S(e['x']), T(e['y']))
            p2 = (S(e['x'] + dx), T(e['y'] + dy))
            d.line([p1, p2], fill=e['strokeColor'], width=max(1, int(2 * scale)))
            ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
            L = 11 * scale
            for s in (+0.45, -0.45):
                d.line([p2, (p2[0] - L * math.cos(ang - s), p2[1] - L * math.sin(ang - s))],
                       fill=e['strokeColor'], width=max(1, int(2 * scale)))
        elif t == 'text':
            size = int(round(e['fontSize'] * scale))
            f = ImageFont.truetype(FONT_B if _bold.get(e['id']) else FONT_R, size)
            for i, line in enumerate(e['text'].split('\n')):
                d.text((S(e['x']), T(e['y'] + i * e['fontSize'] * e['lineHeight'])),
                       line, font=f, fill=e['strokeColor'])
    im = im.quantize(colors=256, dither=Image.NONE)
    path = os.path.join(OUT, NAME + '.png')
    im.save(path, optimize=True)
    return path


if __name__ == '__main__':
    build()
    probs = validate()
    print(f'elements: {len(_elements)}  '
          f'(rect {sum(1 for e in _elements if e["type"] == "rectangle")}, '
          f'text {sum(1 for e in _elements if e["type"] == "text")}, '
          f'arrow {sum(1 for e in _elements if e["type"] == "arrow")}, '
          f'frame {sum(1 for e in _elements if e["type"] == "frame")})')
    print('problems:', len(probs))
    for p in probs[:20]:
        print(' -', p)
    print(export_excalidraw())
    print(export_svg())
    print(export_png())
    sys.exit(1 if probs else 0)
