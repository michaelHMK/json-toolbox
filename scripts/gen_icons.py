#!/usr/bin/env python3
"""生成扩展图标：蓝色圆角方块 + 白色 {} 字形。纯标准库，无第三方依赖。"""
import os
import struct
import zlib

BG = (37, 99, 235)    # #2563eb
FG = (255, 255, 255)  # 白色

LEFT_BRACE = [
    '...##',
    '..##.',
    '..##.',
    '..##.',
    '.##..',
    '..##.',
    '..##.',
    '..##.',
    '...##',
]
RIGHT_BRACE = [row[::-1] for row in LEFT_BRACE]
GLYPH = [l + '.' + r for l, r in zip(LEFT_BRACE, RIGHT_BRACE)]  # 宽 11 高 9

SIZES = (16, 32, 48, 128)


def png_bytes(width, height, rgba):
    def chunk(tag, data):
        raw = tag + data
        return struct.pack('>I', len(data)) + raw + struct.pack('>I', zlib.crc32(raw) & 0xFFFFFFFF)

    scanlines = b''.join(
        b'\x00' + b''.join(struct.pack('4B', *px) for px in row) for row in rgba
    )
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(scanlines, 9))
        + chunk(b'IEND', b'')
    )


def render(size):
    # 商店图标为 128px 画布，方形图案占 96px，四周透明留白 16px。
    padding = 16 if size == 128 else 0
    artwork_size = size - padding * 2
    radius = artwork_size // 5
    cell = max(1, artwork_size // 12)
    gw, gh = len(GLYPH[0]) * cell, len(GLYPH) * cell
    ox, oy = (size - gw) // 2, (size - gh) // 2

    def in_rounded_rect(x, y):
        x, y = x - padding, y - padding
        if not (0 <= x < artwork_size and 0 <= y < artwork_size):
            return False
        dx = max(radius - x, 0, x - (artwork_size - 1 - radius))
        dy = max(radius - y, 0, y - (artwork_size - 1 - radius))
        return dx * dx + dy * dy <= radius * radius

    def in_glyph(x, y):
        gx, gy = x - ox, y - oy
        if 0 <= gx < gw and 0 <= gy < gh:
            return GLYPH[gy // cell][gx // cell] == '#'
        return False

    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            if in_glyph(x, y):
                row.append(FG + (255,))
            elif in_rounded_rect(x, y):
                row.append(BG + (255,))
            else:
                row.append((0, 0, 0, 0))
        rows.append(row)
    return png_bytes(size, size, rows)


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, 'icon%d.png' % size)
        with open(path, 'wb') as f:
            f.write(render(size))
        print('wrote', path)


if __name__ == '__main__':
    main()
