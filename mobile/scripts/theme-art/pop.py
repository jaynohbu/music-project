"""Pop: an arena show. Pink, violet and cyan beams, a glowing LED wall, confetti and phone lights."""
import numpy as np
from stage import *

r = rng(21)
img = np.zeros((h, w, 3), np.float32)
haze = np.clip(noise(31, base=4) ** 1.3 * 1.5, 0, 1.5)
x, y = grid()
PINK, VIOLET, CYAN, WHITE, PEACH = (1.0, 0.25, 0.7), (0.62, 0.3, 1.0), (0.2, 0.85, 1.0), (1, 0.95, 1), (1.0, 0.7, 0.55)

# The LED wall behind the stage: a soft pink-to-cyan gradient with a fine pixel grid.
wall = (y > 0.56) & (y < 0.8) & (np.abs(x - 0.5) < 0.42)
grad = np.stack([0.9 - 0.6 * x, 0.25 + 0.3 * x, 0.7 + 0.3 * x], -1)
pixels = (0.75 + 0.25 * np.cos(x * w * 0.9) * np.cos(y * h * 0.9))
img += (wall * pixels)[..., None] * grad * 0.55
glow(img, (0.5, 0.68), 0.32, PINK, 0.35)

colors = [PINK, VIOLET, CYAN, WHITE]
for i, lx in enumerate(np.linspace(0.04, 0.96, 9)):
    color = colors[i % 4]
    for angle in (r.uniform(-32, -6), r.uniform(6, 32)):
        beam(img, (lx, 0.1), angle, r.uniform(2.5, 4.5), color, 1.5, length=0.8, haze=haze, soft=0.7)
    flare(img, (lx, 0.1), color, 0.3)
# Lasers fanning out from the stage floor.
for side in (-1, 1):
    for k in range(7):
        beam(img, (0.5 + side * 0.3, 0.8), side * (125 + k * 7), 0.35, CYAN if k % 2 else PINK, 2.2, length=1.2, haze=haze, soft=0.5)
# Confetti hanging in the light.
for _ in range(260):
    cx, cy = r.uniform(0, 1), r.uniform(0.15, 0.75)
    glow(img, (cx, cy), r.uniform(0.0015, 0.003), colors[r.integers(4)], r.uniform(1.5, 3.5)) if r.random() < 0.0 else None
conf = np.zeros((h, w), np.float32)
idx = (r.uniform(0.15, 0.75, 900) * h).astype(int), (r.uniform(0, 1, 900) * w).astype(int)
conf[idx] = 1
conf = gaussian_filter(conf, 0.8) * 9
tint = np.array(colors)[r.integers(0, 4, (h, w))]
img += conf[..., None] * tint * 0.9

rgb = finish(img, 1.0, 21, grain=0.03, vig=0.5, glow=0.9)

s = Silhouettes()
for ty in (0.085, 0.105):
    s.rect(0, ty, 1, ty + 0.004)
for k in range(61):
    s.line([(k / 60, 0.088), (k / 60 + 0.0083, 0.106)], 0.002)
FLOOR = 0.82
s.rect(0.05, FLOOR, 0.95, FLOOR + 0.008)
person(s, 0.5, FLOOR, 0.12, 'sing', seed=4)
for k, cx in enumerate((0.26, 0.36, 0.64, 0.74)):
    person(s, cx, FLOOR, 0.1, 'dance', seed=10 + k)
phones = []
crowd(s, 17, 0.86, rows=3, arms=0.55, horns=0, phones=phones)
rgb = s.apply(rgb, rim_color=(1.0, 0.4, 0.8), rim=0.3)
# Phone screens glowing in the raised hands.
for px, py in phones:
    yy, xx = np.ogrid[0:H, 0:W]
    d2 = ((xx - px * W) / 6) ** 2 + ((yy - py * H) / 9) ** 2
    rgb = np.clip(rgb + np.exp(-d2)[..., None] * np.array([0.9, 0.95, 1.0]), 0, 1)
save(rgb, 'theme_pop.jpg')
print('pop done')
