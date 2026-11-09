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
    def __init__(self, title, subtitle, y, bare=False):
        # bare=True: the frame carries a big hero card instead of a drawn header
        self.y, self.cursor, self.bottom = y, y + (36 if bare else 128), y + (36 if bare else 128)
        self.last_h = 0
        self.e = _mk('frame', 0, y, W, 900, '#93c5fd', 'transparent', False, 1, False, None)
        self.e['name'] = title
        self.id = self.e['id']
        if not bare:
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


def build():
    raise SystemExit('lib.py holds primitives only; run build_board.py')


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
