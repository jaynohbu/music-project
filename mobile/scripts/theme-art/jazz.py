"""Jazz club: late night, smoke in one warm spotlight on a saxophonist; table lamps glow out of focus."""
import numpy as np
from stage import *

r = rng(41)
img = np.zeros((h, w, 3), np.float32)
smoke = noise(43, base=3, octaves=6)
haze = np.clip(smoke ** 1.8 * 2.0, 0, 2)
x, y = grid()
WARM, AMBER, BLUE, WINE = (1.0, 0.78, 0.5), (1.0, 0.55, 0.2), (0.25, 0.35, 0.85), (0.6, 0.08, 0.15)

# Midnight-blue room light and a burgundy curtain glow behind the band.
img += (haze * 0.5 + 0.1)[..., None] * np.array(BLUE) * 0.18
curtain = (0.55 + 0.45 * np.cos(x * 70)) * np.exp(-((y - 0.62) / 0.2) ** 2)
img += curtain[..., None] * np.array(WINE) * 0.28
# One spotlight from above on the soloist, and a dimmer one on the bass player.
beam(img, (0.55, 0.0), -5, 14, WARM, 2.0, length=1.3, haze=haze, soft=1.2)
beam(img, (0.22, 0.05), 9, 11, AMBER, 1.2, length=1.2, haze=haze, soft=1.3)
glow(img, (0.5, 0.84), 0.1, WARM, 0.6)
glow(img, (0.27, 0.84), 0.08, AMBER, 0.4)
# Table lamps and candles in the foreground, out of focus.
bokeh(img, 45, 14, (0.0, 0.875, 1.0, 0.9), 0.02, [AMBER, WARM, (1.0, 0.45, 0.15)], 1.3)
# Small lamps on the tables light the room from below.
for cx in (0.1, 0.33, 0.62, 0.88):
    glow(img, (cx, 0.89), 0.012, AMBER, 4.0)
    glow(img, (cx, 0.9), 0.07, AMBER, 0.6)
bokeh(img, 46, 18, (0.0, 0.3, 1.0, 0.6), 0.012, [WARM, AMBER], 0.25)

rgb = finish(img, 1.05, 41, grain=0.045, vig=0.75, glow=0.9)

s = Silhouettes()
FLOOR = 0.86
s.rect(0, FLOOR, 1, FLOOR + 0.005)
person(s, 0.52, FLOOR, 0.15, 'sax', seed=8)
# Upright bass player on the left: the instrument stands taller than his shoulder.
person(s, 0.25, FLOOR, 0.14, 'stand', seed=9)
s.ellipse(0.3, FLOOR - 0.045, 0.045, 0.03)
s.ellipse(0.3, FLOOR - 0.085, 0.035, 0.02)
s.line([(0.3, FLOOR - 0.1), (0.31, FLOOR - 0.17)], 0.007)
s.line([(0.3, FLOOR - 0.01), (0.3, FLOOR)], 0.004)
# A grand piano's lid on the right.
s.poly([(0.68, FLOOR - 0.05), (0.98, FLOOR - 0.05), (0.98, FLOOR - 0.035), (0.68, FLOOR - 0.035)])
s.poly([(0.7, FLOOR - 0.05), (0.95, FLOOR - 0.12), (0.96, FLOOR - 0.115), (0.73, FLOOR - 0.05)])
for lx in (0.71, 0.95):
    s.rect(lx, FLOOR - 0.035, lx + 0.008, FLOOR)
# Listeners at their tables, heads and shoulders against the lamp light.
crowd(s, 47, 0.905, rows=2, arms=0.04, horns=0)
rgb = s.apply(rgb, rim_color=(1.0, 0.7, 0.4), rim=0.35)
save(rgb, 'theme_jazz_band.jpg')
print('jazz done')
