"""Convert the notebook's drawing.eps mountain glyph into a canvas path module.

Mechanical, so nothing is transcribed by hand. Cairo emits:
    x y m                     moveTo
    x y l                     lineTo
    x1 y1 x2 y2 x3 y3 c       bezierCurveTo
    h                         closePath
    f                         fill
with a `1 0 0 -1 0 H cm` CTM in the page setup, i.e. y is flipped about H.
"""
import sys
from collections import Counter

SRC = '/Users/simon/GIT/degenerative_art/drawing.eps'
HEIGHT = 297.0

txt = open(SRC).read()
body = txt.split('%%EndPageSetup', 1)[1]
toks = body.replace('\n', ' ').split()

ops, nums = [], []
for t in toks:
    try:
        nums.append(float(t))
        continue
    except ValueError:
        pass
    if t in ('m', 'l', 'c', 'h', 'f'):
        ops.append((t, nums[:]))
    nums = []

print('op counts:', Counter(o for o, _ in ops), file=sys.stderr)
print('total ops:', len(ops), file=sys.stderr)

xs, ys = [], []
for o, a in ops:
    if o in ('m', 'l', 'c'):
        for i in range(0, len(a), 2):
            xs.append(a[i])
            ys.append(HEIGHT - a[i + 1])
x0, x1 = min(xs), max(xs)
y0, y1 = min(ys), max(ys)
w, h = x1 - x0, y1 - y0
print(f'bbox {w:.1f} x {h:.1f}  (x {x0:.1f}..{x1:.1f}, y {y0:.1f}..{y1:.1f})', file=sys.stderr)

# Normalise into a unit-width box centred on x, sitting on y = 0 with the peak
# at y = -1 * (h/w). Canvas y grows downward, so "up" is negative.
def nx(x):
    return (x - (x0 + x1) / 2) / w

def ny(y):
    return -(y - y0) / w      # same scale on both axes -- no distortion

# Cairo re-issues `x y m` immediately before each `f`, restating the subpath
# start before filling it. Kept, that emits a single-point subpath per shape --
# harmless in a fill, but junk in a path that is also going to be stroked.
ops = [op for i, op in enumerate(ops)
       if not (op[0] == 'm' and i + 1 < len(ops) and ops[i + 1][0] == 'f')]
print('ops after dropping pre-fill moveTo:', len(ops), file=sys.stderr)

lines = []
for o, a in ops:
    if o == 'm':
        lines.append(f'  p.moveTo({nx(a[0]):.4f}, {ny(HEIGHT - a[1]):.4f});')
    elif o == 'l':
        lines.append(f'  p.lineTo({nx(a[0]):.4f}, {ny(HEIGHT - a[1]):.4f});')
    elif o == 'c':
        lines.append(
            f'  p.bezierCurveTo({nx(a[0]):.4f}, {ny(HEIGHT - a[1]):.4f}, '
            f'{nx(a[2]):.4f}, {ny(HEIGHT - a[3]):.4f}, '
            f'{nx(a[4]):.4f}, {ny(HEIGHT - a[5]):.4f});')
    elif o == 'h':
        lines.append('  p.closePath();')

print(f'ASPECT = {h / w:.4f}', file=sys.stderr)
print('\n'.join(lines))
