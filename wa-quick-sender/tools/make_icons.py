"""Generates icons/icon16|32|48|128.png (no dependencies). Run: python3 tools/make_icons.py"""
import os, struct, zlib


def tri(p, a, b, c):
    def s(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1, d2, d3 = s(p, a, b), s(p, b, c), s(p, c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def in_round_rect(x, y, r=0.22):
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def sample(x, y):
    """Colour (r, g, b, a) of a point in 0..1 space: green tile, white chat bubble, green 'send' arrow."""
    if not in_round_rect(x, y):
        return (0, 0, 0, 0)
    t = (x + y) / 2
    bg = (int(37 + (18 - 37) * t), int(211 + (140 - 211) * t), int(102 + (126 - 102) * t))
    in_bubble = (x - 0.5) ** 2 + (y - 0.46) ** 2 <= 0.30 ** 2 or tri((x, y), (0.27, 0.62), (0.22, 0.86), (0.46, 0.74))
    if in_bubble:
        if tri((x, y), (0.40, 0.34), (0.66, 0.46), (0.40, 0.58)):
            return (18, 140, 126, 255)
        return (255, 255, 255, 255)
    return bg + (255,)


def render(size, ss=4):
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter byte
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    cr, cg, cb, ca = sample((px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size)
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
            if a == 0:
                row += bytes([0, 0, 0, 0])
            else:
                row += bytes([round(r / a), round(g / a), round(b / a), round(a / (ss * ss))])
        rows.append(bytes(row))
    return b''.join(rows)


def write_png(path, size):
    raw = render(size)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out, exist_ok=True)
    for s in (16, 32, 48, 128):
        write_png(os.path.join(out, 'icon%d.png' % s), s)
        print('wrote icon%d.png' % s)
