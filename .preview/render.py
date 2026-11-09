"""Render a faithful mock of the new Command Deck so the design can be inspected.

This mirrors the tokens in `apps/web/src/styles/app.css` one-for-one: the same
ink ramp, the same champagne gold, the same glass treatment (translucent fill,
gradient hairline, specular top edge), the same vignette. It exists because there
is no headless browser in this environment, and "the CSS looks right" is not the
same claim as "the screen looks right".

    python3 .preview/render.py      # writes .preview/dashboard.png

Not part of the build. Not referenced by the application.
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import random

W, H = 1440, 900
INK950 = (5, 5, 5)
GOLD200 = (248, 231, 185)
GOLD300 = (240, 212, 147)
GOLD400 = (227, 189, 108)
GOLD500 = (212, 164, 76)
GOLD600 = (184, 134, 47)
MIST100 = (245, 242, 236)
MIST200 = (222, 217, 208)
MIST300 = (192, 186, 176)
MIST400 = (156, 150, 140)
MIST500 = (120, 114, 106)
MINT = (79, 219, 157)
ROSE = (251, 113, 133)
AMBER = (251, 191, 36)
SKY = (56, 189, 248)

img = Image.new('RGB', (W, H), INK950)
d = ImageDraw.Draw(img, 'RGBA')

# --- ambient: two gold light sources, exactly as the body background does
glow = Image.new('RGB', (W // 4, H // 4), INK950)
g = ImageDraw.Draw(glow, 'RGBA')
g.ellipse([-260, -300, 700, 420], fill=(212, 164, 76, 22))
g.ellipse([820, -260, 1500, 340], fill=(227, 189, 108, 14))
glow = glow.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(60))
img = Image.blend(img, glow, 0.85)
d = ImageDraw.Draw(img, 'RGBA')


def font(sz, bold=False):
    for p in [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf' % ('-Bold' if bold else ''),
        '/usr/share/fonts/truetype/liberation/LiberationSans%s.ttf' % ('-Bold' if bold else ''),
    ]:
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
    return ImageFont.load_default()


def glass(box, r=14, alpha=246):
    # Value does the work: the plate is clearly lighter than the page.
    d.rounded_rectangle(box, r, fill=(26, 22, 19))
    # Neutral ink hairline, with gold only where light catches the top-left.
    d.rounded_rectangle(box, r, outline=(44, 37, 29, 235), width=1)
    x0, y0, x1, _ = box
    d.line([(x0 + r, y0), (x0 + r * 3, y0)], fill=(240, 212, 147, 90), width=1)
    # specular top edge
    d.line([(x0 + r, y0 + 1), (x1 - r, y0 + 1)], fill=(255, 255, 255, 12), width=1)


SIDEBAR = 236
img.paste(Image.new('RGBA', (SIDEBAR, H), (10, 9, 8, 238)), (0, 0))
d = ImageDraw.Draw(img, 'RGBA')
d.line([(SIDEBAR - 1, 0), (SIDEBAR - 1, H)], fill=(184, 134, 47, 40), width=1)

# --- logo: metal tile with an engraved inner ring
d.rounded_rectangle([20, 22, 52, 54], 10, fill=GOLD400)
d.rounded_rectangle([20, 22, 52, 54], 10, outline=(255, 255, 255, 90), width=1)
d.rounded_rectangle([23, 25, 49, 51], 8, outline=(26, 20, 9, 70), width=1)
d.line([(28, 40), (28, 28), (36, 28)], fill=(26, 20, 9), width=3)
d.text((62, 24), 'Relay', font=font(15, True), fill=MIST100)
d.text((110, 24), 'OSS', font=font(15, True), fill=GOLD400)
d.text((62, 44), 'DELIVERY OS', font=font(8), fill=GOLD600)

NAV = [
    ('Operate', [('Command Deck', 'G', True), ('Board', 'B', False), ('Pipeline', 'P', False), ('Turnover Clocks', 'T', False)]),
    ('Deliver', [('Projects', 'J', False), ('Planning & Capacity', 'C', False), ('QA Centre', None, False), ('Releases', None, False)]),
    ('Business', [('Clients', None, False), ('Partner Console', None, False), ('Intelligence', None, False), ('Knowledge', None, False)]),
]
y = 88
for group, items in NAV:
    d.text((14, y), group.upper(), font=font(8), fill=(120, 114, 106, 170))
    y += 18
    for label, hint, active in items:
        if active:
            ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            do = ImageDraw.Draw(ov, 'RGBA')
            for i in range(SIDEBAR - 20):
                a = int(40 * (1 - i / (SIDEBAR - 20)))
                do.line([(10 + i, y), (10 + i, y + 30)], fill=(212, 164, 76, max(0, a)))
            img.paste(ov, (0, 0), ov)
            d = ImageDraw.Draw(img, 'RGBA')
            d.rounded_rectangle([1, y + 6, 3, y + 24], 1, fill=GOLD300)
        col = MIST100 if active else MIST400
        d.rounded_rectangle([14, y + 9, 24, y + 19], 2, outline=(GOLD300 if active else MIST500) + (255,), width=1)
        d.text((34, y + 8), label, font=font(12), fill=col)
        if hint and active:
            d.rounded_rectangle([200, y + 9, 214, y + 23], 3, fill=(32, 28, 24), outline=(58, 49, 40), width=1)
            d.text((204, y + 11), hint, font=font(8), fill=MIST400)
        y += 32
    y += 10

# --- header
d.rectangle([SIDEBAR, 0, W, 52], fill=(10, 9, 8, 235))
d.line([(SIDEBAR, 51), (W, 51)], fill=(184, 134, 47, 45), width=1)
d.text((SIDEBAR + 18, 17), 'Command Deck', font=font(12, True), fill=MIST300)
d.text((SIDEBAR + 138, 18), '/   Studio overview', font=font(11), fill=MIST500)
d.rounded_rectangle([W - 330, 15, W - 238, 38], 7, fill=(14, 12, 10), outline=(184, 134, 47, 80), width=1)
d.ellipse([W - 318, 24, W - 312, 30], fill=MINT)
d.text((W - 306, 19), 'API live', font=font(10), fill=MIST400)
d.rounded_rectangle([W - 228, 15, W - 160, 38], 7, fill=(14, 12, 10), outline=(44, 37, 29), width=1)
d.text((W - 218, 19), 'Maya I.', font=font(10), fill=MIST300)
d.rounded_rectangle([W - 150, 15, W - 120, 38], 7, fill=(212, 164, 76, 25), outline=(212, 164, 76, 80), width=1)
d.text((W - 143, 20), 'admin', font=font(9), fill=GOLD300)

# --- hero
CX = SIDEBAR + 28
d.rounded_rectangle([CX, 78, CX + 250, 100], 11, fill=(212, 164, 76, 18), outline=(184, 134, 47, 90), width=1)
d.ellipse([CX + 10, 86, CX + 16, 92], fill=GOLD400)
d.text((CX + 24, 82), 'STUDIO · MON, 8 NOVEMBER', font=font(9), fill=GOLD300)
d.text((CX, 112), 'Good evening,', font=font(30, True), fill=(255, 255, 255))
# the gold gradient display line
tw = d.textlength('the deck is live.', font=font(30, True))
tg = Image.new('RGB', (int(tw) + 4, 44), INK950)
dtg = ImageDraw.Draw(tg)
for i in range(44):
    t = i / 43
    dtg.line([(0, i), (tw + 4, i)], fill=(int(248 - 52 * t), int(231 - 74 * t), int(185 - 79 * t)))
mask = Image.new('L', (int(tw) + 4, 44), 0)
ImageDraw.Draw(mask).text((0, 0), 'the deck is live.', font=font(30, True), fill=255)
img.paste(tg, (CX, 152), mask)
d = ImageDraw.Draw(img, 'RGBA')
d.text((CX, 188), '34 open units of work across 6 client projects · 2 SLA breaches · 3 blocked · Rs 1.2Cr in the pipe, Rs 64L weighted.',
       font=font(11), fill=MIST400)

bx = W - 330
d.rounded_rectangle([bx, 140, bx + 140, 176], 9, fill=(25, 22, 20, 200), outline=(44, 37, 29), width=1)
d.text((bx + 40, 152), 'Open board', font=font(11), fill=MIST200)
d.rounded_rectangle([bx + 150, 140, bx + 310, 176], 9, fill=GOLD400)
d.line([(bx + 152, 141), (bx + 308, 141)], fill=(255, 255, 255, 120), width=1)
d.text((bx + 196, 152), 'Run planner', font=font(11, True), fill=(26, 20, 9))

# --- KPI rail
kpis = [
    ('IN FLIGHT', '14', GOLD300, 'of 34 open', 0.41),
    ('SLA BREACHES', '2', ROSE, 'needs review', 0.18),
    ('BLOCKED', '3', AMBER, 'awaiting input', 0.09),
    ('WEIGHTED', 'Rs 64L', MINT, 'of Rs 1.2Cr', 0.53),
    ('AGREED VALUE', 'Rs 98L', SKY, '6 projects', 0.72),
    ('COMPLIANCE', '87%', GOLD300, '+4 this week', 0.87),
]
cw = (W - SIDEBAR - 56 - 5 * 10) // 6
cy = 228
for i, (label, val, tone, sub, prog) in enumerate(kpis):
    x = CX + i * (cw + 10)
    glass([x, cy, x + cw, cy + 104])
    d.text((x + 14, cy + 13), label, font=font(8), fill=MIST500)
    ic = ('^', '!', '||', 'Rs', '#', '%')[i]
    d.text((x + cw - 12 - d.textlength(ic, font=font(9, True)), cy + 11), ic, font=font(9, True), fill=tone + (200,) if len(tone) == 3 else tone)
    d.text((x + 14, cy + 30), val, font=font(24, True), fill=(255, 255, 255))
    d.text((x + 14, cy + 68), sub, font=font(9), fill=MIST500)
    d.rounded_rectangle([x + 14, cy + 88, x + cw - 14, cy + 91], 2, fill=(32, 28, 24))
    d.rounded_rectangle([x + 14, cy + 88, x + 14 + int((cw - 28) * prog), cy + 91], 2, fill=tone)

# --- throughput chart
ch = [CX, cy + 124, W - 28, cy + 470]
glass(ch, r=16)
d.text((CX + 22, cy + 146), 'Throughput', font=font(13, True), fill=(255, 255, 255))
d.text((CX + 22, cy + 166), 'Created against shipped, last 14 days', font=font(10), fill=MIST500)
gy0, gy1 = cy + 200, cy + 430
for i in range(6):
    yy = gy0 + i * (gy1 - gy0) // 5
    d.line([(CX + 22, yy), (W - 50, yy)], fill=(34, 29, 23), width=1)
random.seed(7)


def series(base, amp, n=28, up=0.6):
    pts, v = [], base
    for _ in range(n):
        v += random.uniform(-amp, amp * up)
        pts.append(v)
    return pts


def trending(start, end, amp, n=28):
    """A series that actually trends, so the chart reads as growth not decay."""
    out = []
    for i in range(n):
        t = i / (n - 1)
        out.append(start + (end - start) * t + random.uniform(-amp, amp))
    return out


a = trending(0.22, 0.72, 0.045)
b2 = trending(0.16, 0.52, 0.035)


def draw_area(pts, color, fill_alpha):
    n = len(pts)
    x0, x1 = CX + 22, W - 50
    xs = [x0 + i * (x1 - x0) / (n - 1) for i in range(n)]
    ys = [gy1 - (p * (gy1 - gy0)) for p in pts]
    poly = list(zip(xs, ys)) + [(xs[-1], gy1), (xs[0], gy1)]
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    do = ImageDraw.Draw(ov, 'RGBA')
    do.polygon(poly, fill=color + (fill_alpha,))
    # Fade the fill to nothing at the baseline: a filled slab muddying a second
    # series underneath is what made the chart look olive.
    fade = Image.new('L', (W, H), 0)
    df = ImageDraw.Draw(fade)
    for i in range(gy1 - gy0):
        t = i / (gy1 - gy0)
        df.line([(0, gy0 + i), (W, gy0 + i)], fill=int(255 * (1 - t) ** 1.4))
    alpha = ov.split()[3].point(lambda v: v)
    alpha = Image.composite(alpha, Image.new('L', (W, H), 0), fade)
    ov.putalpha(alpha)
    img.paste(ov, (0, 0), ov)
    dd = ImageDraw.Draw(img, 'RGBA')
    dd.line(list(zip(xs, ys)), fill=color + (255,), width=2, joint='curve')


draw_area(b2, MINT, 46)
draw_area(a, GOLD400, 62)

# --- two lower cards
half = (W - 28 - CX - 16) // 2
for i, (title, rows) in enumerate([
    ('Watchlist', [('NRTH-102  · turnover due in 6h', ROSE), ('Atlas consultation in 2h', AMBER), ('Kite plan revision overdue', ROSE)]),
    ('Clocks', [('Consultation -> plan', MINT), ('Module turnover', AMBER), ('QA report 12h', MINT)]),
]):
    x = CX + i * (half + 16)
    y2 = cy + 490
    glass([x, y2, x + half, y2 + 150], r=16)
    d.text((x + 20, y2 + 16), title, font=font(12, True), fill=(255, 255, 255))
    d.line([(x + 20, y2 + 38), (x + half - 20, y2 + 38)], fill=(34, 29, 23), width=1)
    for j, (txt, tone) in enumerate(rows):
        yy = y2 + 52 + j * 32
        d.ellipse([x + 20, yy + 5, x + 26, yy + 11], fill=tone)
        d.text((x + 34, yy), txt, font=font(10), fill=MIST300)

# --- vignette, as `.vignette::before` does
vig = Image.new('L', (W // 4, H // 4), 0)
dv = ImageDraw.Draw(vig)
dv.ellipse([-W // 6, -H // 6, W // 4 + W // 6, H // 4 + H // 6], fill=255)
vig = vig.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(110))
px, vx = img.load(), vig.load()
for yy in range(H):
    for xx in range(W):
        k = 0.72 + 0.28 * (vx[xx, yy] / 255.0)
        r, g_, b = px[xx, yy]
        px[xx, yy] = (int(r * k), int(g_ * k), int(b * k))

img.save('/home/user/RELAYOSS/.preview/dashboard.png')
print('rendered .preview/dashboard.png', img.size)
