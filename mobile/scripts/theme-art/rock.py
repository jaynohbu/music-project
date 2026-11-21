"""Rock: a packed club gig seen from the floor. Amber and red lamps cut through haze over a backlit band."""
import numpy as np
from stage import *

r = rng(11)
img = np.zeros((h, w, 3), np.float32)
smoke = noise(3, base=5) ** 1.6
haze = np.clip(smoke * 1.4 + noise(9, base=2) * 0.3, 0, 1.4)
x, y = grid()

AMBER, ORANGE, RED, WHITE = (1.0, 0.6, 0.2), (1.0, 0.36, 0.07), (1.0, 0.1, 0.05), (1.0, 0.9, 0.78)
# Upper truss: narrow beams fanning and crossing.
upper = [(0.06, RED), (0.18, AMBER), (0.3, ORANGE), (0.42, WHITE), (0.58, WHITE), (0.7, ORANGE), (0.82, AMBER), (0.94, RED)]
for i, (lx, color) in enumerate(upper):
    for angle in (r.uniform(-38, -8), r.uniform(8, 38)):
        beam(img, (lx, 0.14), angle, r.uniform(3, 5.5), color, 1.6, length=0.7, haze=haze, soft=0.7)
    flare(img, (lx, 0.14), color, 0.35)
# Lower side lights raking across the stage.
for lx, ang, color in [(0.0, 62, AMBER), (1.0, -62, AMBER), (0.0, 48, RED), (1.0, -48, RED)]:
    beam(img, (lx, 0.62), ang, 6, color, 1.2, length=0.8, haze=haze)
# Back lights behind the band, shooting up into the haze.
for lx, ang, color in [(0.36, 172, ORANGE), (0.5, 180, WHITE), (0.64, 188, ORANGE), (0.43, 165, RED), (0.57, 195, RED)]:
    beam(img, (lx, 0.8), ang, 5, color, 1.8, length=0.7, haze=haze, soft=0.8)
glow(img, (0.5, 0.8), 0.22, ORANGE, 0.7)
glow(img, (0.5, 0.82), 0.07, WHITE, 1.0)
img += (haze * np.exp(-((y - 0.6) / 0.35) ** 2))[..., None] * np.array([0.12, 0.04, 0.012])

rgb = finish(img, 0.9, 11, grain=0.04, vig=0.65, glow=0.8)

s = Silhouettes()
for ty in (0.13, 0.152):
    s.rect(0, ty, 1, ty + 0.004)
for k in range(61):
    s.line([(k / 60, 0.133), (k / 60 + 0.0083, 0.153)], 0.002)
for lx, _ in upper:
    s.rect(lx - 0.014, 0.153, lx + 0.014, 0.162)
# Stage near the bottom: amps, drums and the band, backlit; the crowd's heads cut into the glow.
FLOOR = 0.83
s.rect(0.08, FLOOR - 0.075, 0.2, FLOOR)
s.rect(0.8, FLOOR - 0.075, 0.92, FLOOR)
s.rect(0.4, FLOOR - 0.035, 0.6, FLOOR)
s.ellipse(0.42, FLOOR - 0.06, 0.035, 0.0035)
s.ellipse(0.58, FLOOR - 0.065, 0.03, 0.0035)
s.line([(0.42, FLOOR - 0.06), (0.42, FLOOR - 0.035)], 0.003)
s.line([(0.58, FLOOR - 0.065), (0.58, FLOOR - 0.035)], 0.003)
person(s, 0.5, FLOOR, 0.13, 'guitar', seed=1)
person(s, 0.28, FLOOR, 0.115, 'guitar', seed=2)
person(s, 0.73, FLOOR, 0.115, 'guitar', seed=3)
s.rect(0, FLOOR, 1, FLOOR + 0.006)
crowd(s, 7, 0.87, rows=3, arms=0.45, horns=0.25)
rgb = s.apply(rgb, rim_color=(1.0, 0.5, 0.18), rim=0.25)
save(rgb, 'theme_rock.jpg')
print('rock done')
