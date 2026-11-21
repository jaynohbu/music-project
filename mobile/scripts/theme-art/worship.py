"""Worship: soft morning light pours down through haze over a congregation with hands raised."""
import numpy as np
from stage import *

r = rng(61)
img = np.zeros((h, w, 3), np.float32)
haze = np.clip(noise(63, base=3) ** 1.4 * 1.3 + 0.15, 0, 1.4)
x, y = grid()
GOLD, CREAM, SKY, WHITE = (1.0, 0.82, 0.55), (1.0, 0.94, 0.82), (0.75, 0.86, 1.0), (1, 1, 1)

# A bright, airy room: cream above fading to warm gold at the stage, with a cool sky tint at the top.
img += np.stack([0.9 + 0 * y, 0.78 + 0.05 * y, 0.6 + 0.1 * (1 - y)], -1) * 0.32
img += (np.exp(-((y - 0.0) / 0.25) ** 2))[..., None] * np.array(SKY) * 0.4
# Light rays fanning down from high windows.
for k, angle in enumerate(np.linspace(-34, 34, 9)):
    beam(img, (0.5 + angle / 400, -0.05), angle + r.uniform(-2, 2), r.uniform(4, 7), CREAM if k % 2 else GOLD, 1.5,
         length=1.4, haze=haze, soft=1.6)
glow(img, (0.5, 0.02), 0.2, WHITE, 0.9)
glow(img, (0.5, 0.78), 0.3, GOLD, 0.8)
bokeh(img, 65, 30, (0, 0.2, 1, 0.75), 0.016, [WHITE, GOLD, CREAM], 0.35)

rgb = finish(img, 1.0, 61, grain=0.022, vig=0.3, glow=0.5)

s = Silhouettes()
FLOOR = 0.8
# A simple cross on the stage wall, lit from behind.
s.rect(0.49, 0.6, 0.51, 0.74)
s.rect(0.455, 0.635, 0.545, 0.648)
s.rect(0.1, FLOOR, 0.9, FLOOR + 0.006)
person(s, 0.32, FLOOR, 0.1, 'sing', seed=21)
person(s, 0.68, FLOOR, 0.1, 'guitar', seed=22)
crowd(s, 67, 0.84, rows=4, arms=0.85, horns=0)
rgb = s.apply(rgb, rim_color=(1.0, 0.9, 0.7), rim=0.45, darkness=0.82, base=(0.16, 0.11, 0.07))
save(rgb, 'theme_christian.jpg')
print('worship done')
