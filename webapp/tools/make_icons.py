"""Generate the PWA icons (PNG) with the standard library only.

Run from anywhere: python3 webapp/tools/make_icons.py
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')

BG = (23, 24, 27)
TAPE = (251, 251, 248)
INK = (23, 24, 27)
ACCENT = (59, 91, 253)
SS = 4  # supersampling per axis


def rounded_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shade(x, y, maskable):
    """Colour at unit coordinates, or None for transparent."""
    if not maskable and not rounded_rect(x, y, 0, 0, 1, 1, 0.22):
        return None
    if rounded_rect(x, y, 0.14, 0.36, 0.86, 0.64, 0.02):
        if rounded_rect(x, y, 0.23, 0.425, 0.62, 0.475, 0.025):
            return INK
        if rounded_rect(x, y, 0.23, 0.525, 0.50, 0.575, 0.025):
            return INK
        if abs(x - 0.73) <= 0.008 and (y * 25) % 1 < 0.55:
            return ACCENT
        return TAPE
    return BG


def render(size, maskable):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, maskable)
                    if c is not None:
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        acc[3] += 1
            n = acc[3]
            if n:
                row += bytes((acc[0] // n, acc[1] // n, acc[2] // n, 255 * n // (SS * SS)))
            else:
                row += b'\0\0\0\0'
        rows.append(bytes(row))
    return b''.join(rows)


def png(size, pixels):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b''))


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, maskable in [
        ('icon-192.png', 192, False),
        ('icon-512.png', 512, False),
        ('maskable-512.png', 512, True),
        ('apple-touch-icon.png', 180, True),
    ]:
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(png(size, render(size, maskable)))
        print('wrote', name)


if __name__ == '__main__':
    main()
