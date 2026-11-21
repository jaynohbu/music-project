"""Procedural stage photography: additive light beams through haze, bokeh, silhouettes, grain.

Everything is rendered in linear light at half resolution, tone mapped, then upscaled; silhouettes
and grain are added at full resolution so their edges stay crisp."""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import gaussian_filter, zoom

W, H = 1170, 2532
SCALE = 2
w, h = W // SCALE, H // SCALE


def rng(seed):
    return np.random.default_rng(seed)


def grid():
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    return x / w, y / h  # 0..1


def noise(seed, octaves=5, base=6):
    """Fractal value noise, 0..1, for haze and smoke."""
    r = rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = base * 2 ** o
        small = r.random((n + 1, int(n * w / h) + 2)).astype(np.float32)
        layer = zoom(small, (h / small.shape[0], w / small.shape[1]), order=3)[:h, :w]
        out += amp * layer
        total += amp
        amp *= 0.5
    out /= total
    return (out - out.min()) / (out.max() - out.min() + 1e-9)


def beam(img, origin, angle_deg, spread_deg, color, power, length=1.6, haze=None, soft=1.0):
    """A light beam from `origin` (0..1 coords, y down) pointing at `angle_deg` (0 = down, + = right)."""
    x, y = grid()
    ox, oy = origin
    dx, dy = (x - ox) * (w / h), y - oy
    dist = np.sqrt(dx * dx + dy * dy) + 1e-6
    a = math.radians(angle_deg)
    along = dx * math.sin(a) + dy * math.cos(a)
    across = np.abs(-dx * math.cos(a) + dy * math.sin(a))
    half = math.tan(math.radians(spread_deg) / 2)
    width = np.maximum(along, 1e-4) * half + 0.002
    core = np.exp(-(across / width) ** 2 * (2.2 / soft))
    fall = np.clip(along, 0, None) / (along.clip(1e-4) + 0.02) * np.exp(-np.clip(along, 0, None) / length)
    strength = core * fall * (along > 0)
    # Brighter near the lamp, and visible mainly where there is haze to scatter the light.
    strength = strength * (0.35 + 0.65 * np.exp(-dist * 2.5))
    if haze is not None:
        strength = strength * (0.35 + 0.9 * haze)
    img += strength[..., None] * np.array(color, np.float32) * power


def glow(img, center, radius, color, power):
    x, y = grid()
    cx, cy = center
    d2 = ((x - cx) * (w / h)) ** 2 + (y - cy) ** 2
    img += (np.exp(-d2 / (radius ** 2)))[..., None] * np.array(color, np.float32) * power


def bokeh(img, seed, count, area, size, colors, power):
    """Out-of-focus lights: soft discs with a slightly brighter rim, like a real lens."""
    r = rng(seed)
    x, y = grid()
    x0, y0, x1, y1 = area
    for _ in range(count):
        cx, cy = r.uniform(x0, x1), r.uniform(y0, y1)
        rad = size * r.uniform(0.5, 1.4)
        d = np.sqrt(((x - cx) * (w / h)) ** 2 + (y - cy) ** 2) / rad
        disc = np.clip(1.15 - d, 0, 1) ** 0.6 * (0.7 + 0.5 * np.exp(-((d - 0.9) / 0.08) ** 2))
        col = np.array(colors[r.integers(len(colors))], np.float32)
        img += (disc * (d < 1.2))[..., None] * col * power * r.uniform(0.4, 1.0)


def tonemap(img, exposure=1.0, contrast=1.08):
    x = 1 - np.exp(-img * exposure)
    x = np.clip(x, 0, 1) ** (1 / 2.2)
    x = 0.5 + (x - 0.5) * contrast
    return np.clip(x, 0, 1)


def vignette(rgb, strength=0.55):
    yy, xx = np.mgrid[0:rgb.shape[0], 0:rgb.shape[1]].astype(np.float32)
    nx, ny = xx / rgb.shape[1] - 0.5, yy / rgb.shape[0] - 0.5
    v = 1 - strength * (nx * nx * 2.2 + ny * ny * 1.1)
    return rgb * np.clip(v, 0, 1)[..., None]


def bloom(lin, threshold=0.6, strength=0.6):
    """Bright light spills into its surroundings, as it does in a lens and in haze."""
    bright = np.clip(lin - threshold, 0, None)
    spread = sum(np.stack([gaussian_filter(bright[..., c], s) for c in range(3)], -1) * k for s, k in ((4, .5), (14, .35), (40, .25)))
    return lin + spread * strength


def flare(img, center, color, power, streak=0.25):
    """A lamp seen straight on: a hot core, a soft halo and a faint horizontal streak."""
    x, y = grid()
    cx, cy = center
    dx, dy = (x - cx) * (w / h), y - cy
    d2 = dx * dx + dy * dy
    col = np.array(color, np.float32)
    img += (np.exp(-d2 / 0.00004) * 8 + np.exp(-d2 / 0.0012) * 1.2)[..., None] * col * power
    img += (np.exp(-(dy / 0.0018) ** 2) * np.exp(-np.abs(dx) / streak))[..., None] * col * power * 0.35


def finish(lin, exposure, seed, grain=0.035, vig=0.5, tint=None, glow=0.6):
    """Bloom, tone map, upscale to full resolution, add vignette and film grain."""
    rgb = tonemap(bloom(lin, strength=glow), exposure)
    if tint is not None:
        rgb = np.clip(rgb * np.array(tint, np.float32), 0, 1)
    big = np.stack([zoom(rgb[..., c], SCALE, order=3) for c in range(3)], -1)[:H, :W]
    big = vignette(big, vig)
    g = rng(seed).normal(0, grain, (H, W, 1)).astype(np.float32)
    big = np.clip(big + g * (0.4 + big), 0, 1)
    return big


class Silhouettes:
    """Black shapes drawn at full resolution, with an optional coloured rim from the light behind."""

    def __init__(self):
        self.mask = Image.new('L', (W, H), 0)
        self.draw = ImageDraw.Draw(self.mask)

    def poly(self, points):
        self.draw.polygon([(px * W, py * H) for px, py in points], fill=255)

    def ellipse(self, cx, cy, rx, ry):
        self.draw.ellipse([(cx - rx) * W, (cy - ry) * H, (cx + rx) * W, (cy + ry) * H], fill=255)

    def line(self, points, width):
        self.draw.line([(px * W, py * H) for px, py in points], fill=255, width=int(width * W), joint='curve')

    def rect(self, x0, y0, x1, y1):
        if y0 < y1 and x0 < x1:
            self.draw.rectangle([x0 * W, y0 * H, x1 * W, y1 * H], fill=255)

    def apply(self, rgb, rim_color=None, rim=0.6, darkness=0.96, base=(0.01, 0.01, 0.012)):
        m = np.asarray(self.mask.filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
        out = rgb * (1 - m[..., None] * darkness) + m[..., None] * np.array(base, np.float32) * darkness
        if rim_color is not None:
            edge = np.asarray(self.mask.filter(ImageFilter.GaussianBlur(6)), np.float32) / 255
            ring = np.clip(edge - m, 0, 1) * 2.2
            out = out + ring[..., None] * np.array(rim_color, np.float32) * rim
        return np.clip(out, 0, 1)


def crowd(sil, seed, top, rows=5, arms=0.4, phones=None, horns=0.15):
    """A crowd seen from behind, nearer rows larger: heads, shoulders and raised arms with hands."""
    r = rng(seed)
    for row in range(rows):
        t = row / max(rows - 1, 1)
        y = top + (1 - top) * (t ** 1.3) * 0.7
        size = 0.012 + 0.03 * t ** 1.4
        n = int(1.0 / (size * 1.9)) + 2
        for i in range(n):
            cx = (i + r.uniform(-0.35, 0.35)) / (n - 1)
            hr = size * r.uniform(0.85, 1.15)
            hy = y + r.uniform(-0.25, 0.25) * hr * W / H
            ry = hr * W / H * 1.15
            sil.ellipse(cx, hy, hr, ry)
            sil.ellipse(cx, hy + ry * 2.1, hr * 2.3, ry * 1.4)
            sil.rect(cx - hr * 2.2, hy + ry * 2.1, cx + hr * 2.2, 1)
            if r.random() < arms:
                side = r.choice([-1, 1])
                ang = math.radians(r.uniform(-28, 18) * side)
                length = hr * r.uniform(5.5, 7.5) * W / H
                sx, sy = cx + side * hr * 1.5, hy + ry * 1.8
                mx, my = sx + math.sin(ang) * length * 0.5 * H / W, sy - math.cos(ang) * length * 0.5
                ex, ey = mx + math.sin(ang * 0.6) * length * 0.5 * H / W, my - math.cos(ang * 0.6) * length * 0.5
                sil.line([(sx, sy), (mx, my)], hr * 0.75)
                sil.line([(mx, my), (ex, ey)], hr * 0.6)
                sil.ellipse(ex, ey - ry * 0.25, hr * 0.42, ry * 0.5)
                if r.random() < horns:
                    sil.line([(ex - hr * 0.25, ey - ry * 0.4), (ex - hr * 0.35, ey - ry * 1.3)], hr * 0.16)
                    sil.line([(ex + hr * 0.25, ey - ry * 0.4), (ex + hr * 0.35, ey - ry * 1.3)], hr * 0.16)
                if phones is not None and r.random() < 0.3:
                    phones.append((ex, ey - ry * 0.9))


def limb(sil, points, width):
    """A rounded limb: a thick line with round ends and joints."""
    sil.line(points, width)
    for px, py in points:
        sil.ellipse(px, py, width / 2, width / 2 * W / H)


def person(sil, cx, foot, height, pose='guitar', seed=0):
    """A standing performer about `height` tall (fraction of the image), feet on `foot`."""
    r = rng(seed)
    u = height
    ax = H / W  # x units per y unit, so shapes keep their proportions
    head = (cx + r.uniform(-.01, .01) * u, foot - u * 0.9)
    sil.ellipse(head[0], head[1], u * 0.065 * ax * 1.0, u * 0.065)
    # Hair falls to the shoulders.
    sil.poly([(head[0] - u * .07 * ax, head[1]), (head[0] + u * .07 * ax, head[1]), (head[0] + u * .08 * ax, head[1] + u * .12), (head[0] - u * .08 * ax, head[1] + u * .12)])
    neck = (cx, foot - u * 0.8)
    hip = (cx, foot - u * 0.45)
    sh_l, sh_r = (cx - u * .11 * ax, foot - u * .78), (cx + u * .11 * ax, foot - u * .78)
    sil.poly([sh_l, sh_r, (hip[0] + u * .08 * ax, hip[1]), (hip[0] - u * .08 * ax, hip[1])])
    stance = u * r.uniform(.16, .22) * ax
    limb(sil, [(hip[0] - u * .05 * ax, hip[1]), (cx - stance * .7, foot - u * .22), (cx - stance, foot - u * .01)], u * .085 * ax)
    limb(sil, [(hip[0] + u * .05 * ax, hip[1]), (cx + stance * .7, foot - u * .22), (cx + stance, foot - u * .01)], u * .085 * ax)
    if pose == 'guitar':
        body = (cx + u * .02 * ax, foot - u * .47)
        sil.ellipse(body[0], body[1], u * .15 * ax, u * .085)
        limb(sil, [(body[0] + u * .08 * ax, body[1] - u * .02), (body[0] + u * .42 * ax, body[1] - u * .2)], u * .035 * ax)
        limb(sil, [sh_l, (cx - u * .1 * ax, foot - u * .55), (body[0] - u * .02 * ax, body[1])], u * .07 * ax)
        limb(sil, [sh_r, (cx + u * .2 * ax, foot - u * .6), (body[0] + u * .25 * ax, body[1] - u * .12)], u * .07 * ax)
    elif pose == 'sing':
        limb(sil, [sh_l, (cx - u * .14 * ax, foot - u * .62), (cx - u * .02 * ax, foot - u * .86)], u * .07 * ax)
        limb(sil, [sh_r, (cx + u * .25 * ax, foot - u * .95), (cx + u * .3 * ax, foot - u * 1.15)], u * .07 * ax)
    elif pose == 'sax':
        sil.line([(cx + u * .02 * ax, foot - u * .82), (cx + u * .1 * ax, foot - u * .5), (cx + u * .03 * ax, foot - u * .38)], u * .05 * ax)
        sil.ellipse(cx + u * .07 * ax, foot - u * .38, u * .09 * ax, u * .05)
        limb(sil, [sh_l, (cx - u * .05 * ax, foot - u * .6), (cx + u * .06 * ax, foot - u * .62)], u * .07 * ax)
        limb(sil, [sh_r, (cx + u * .17 * ax, foot - u * .55), (cx + u * .09 * ax, foot - u * .45)], u * .07 * ax)
    else:
        limb(sil, [sh_l, (cx - u * .14 * ax, foot - u * .5), (cx - u * .1 * ax, foot - u * .4)], u * .07 * ax)
        limb(sil, [sh_r, (cx + u * .14 * ax, foot - u * .5), (cx + u * .1 * ax, foot - u * .4)], u * .07 * ax)


def save(rgb, path, quality=88):
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(path, quality=quality, optimize=True, progressive=True)
