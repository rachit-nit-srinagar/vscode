#!/usr/bin/env python3
"""Generate Lens app icons (PNG / ICNS / ICO) from the concentric-circle mark."""

from __future__ import annotations

import math
import struct
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BG = (15, 17, 23, 255)
ACCENT = (76, 139, 245, 255)
TRANSPARENT = (0, 0, 0, 0)


def png_bytes(width: int, height: int, pixels: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw = bytearray()
    row = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * row : (y + 1) * row])
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def blend(dst: tuple[int, int, int, int], src: tuple[int, int, int, int], alpha: float) -> tuple[int, int, int, int]:
    a = max(0.0, min(1.0, alpha))
    return (
        int(dst[0] + (src[0] - dst[0]) * a),
        int(dst[1] + (src[1] - dst[1]) * a),
        int(dst[2] + (src[2] - dst[2]) * a),
        255,
    )


def draw_lens(size: int, rounded: bool) -> bytes:
    pixels = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2.0
    outer = size * 0.33
    ring = size * 0.035
    inner = size * 0.135
    corner = size * 0.18

    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            dist = math.hypot(dx, dy)
            color = BG
            if rounded:
                # rounded-rect mask
                ax, ay = abs(dx), abs(dy)
                half = size / 2.0
                if ax > half - corner and ay > half - corner:
                    rdist = math.hypot(ax - (half - corner), ay - (half - corner))
                    if rdist > corner:
                        color = TRANSPARENT
            ring_alpha = max(0.0, 1.0 - abs(dist - outer) / ring)
            if ring_alpha > 0:
                color = blend(color if color != TRANSPARENT else BG, ACCENT, min(1.0, ring_alpha))
            if dist <= inner:
                color = ACCENT
            i = (y * size + x) * 4
            pixels[i : i + 4] = bytes(color)
    return png_bytes(size, size, bytes(pixels))


def write_ico(path: Path, pngs: list[bytes]) -> None:
    count = len(pngs)
    offset = 6 + 16 * count
    entries = bytearray()
    payload = bytearray()
    for png in pngs:
        # PNG IHDR width/height at bytes 16-23
        width = struct.unpack(">I", png[16:20])[0]
        height = struct.unpack(">I", png[20:24])[0]
        entries.extend(
            struct.pack(
                "<BBBBHHII",
                width if width < 256 else 0,
                height if height < 256 else 0,
                0,
                0,
                1,
                32,
                len(png),
                offset,
            )
        )
        payload.extend(png)
        offset += len(png)
    path.write_bytes(b"\x00\x00\x01\x00" + struct.pack("<H", count) + bytes(entries) + bytes(payload))


def main() -> None:
    linux_dir = ROOT / "resources" / "linux"
    win_dir = ROOT / "resources" / "win32"
    darwin_dir = ROOT / "resources" / "darwin"
    linux_dir.mkdir(parents=True, exist_ok=True)
    win_dir.mkdir(parents=True, exist_ok=True)
    darwin_dir.mkdir(parents=True, exist_ok=True)

    png_1024 = draw_lens(1024, rounded=True)
    png_512 = draw_lens(512, rounded=True)
    png_256 = draw_lens(256, rounded=True)
    png_128 = draw_lens(128, rounded=True)
    png_64 = draw_lens(64, rounded=True)
    png_48 = draw_lens(48, rounded=True)
    png_32 = draw_lens(32, rounded=True)
    png_16 = draw_lens(16, rounded=True)

    (linux_dir / "code.png").write_bytes(png_512)
    (win_dir / "code_150x150.png").write_bytes(draw_lens(150, rounded=True))
    (win_dir / "code_70x70.png").write_bytes(draw_lens(70, rounded=True))
    write_ico(win_dir / "code.ico", [png_256, png_128, png_64, png_48, png_32, png_16])

    try:
        import shutil
        import subprocess

        if shutil.which("iconutil"):
            with tempfile.TemporaryDirectory() as tmp:
                iconset = Path(tmp) / "Lens.iconset"
                iconset.mkdir()
                sizes = {
                    "icon_16x16.png": 16,
                    "icon_16x16@2x.png": 32,
                    "icon_32x32.png": 32,
                    "icon_32x32@2x.png": 64,
                    "icon_128x128.png": 128,
                    "icon_128x128@2x.png": 256,
                    "icon_256x256.png": 256,
                    "icon_256x256@2x.png": 512,
                    "icon_512x512.png": 512,
                    "icon_512x512@2x.png": 1024,
                }
                for name, size in sizes.items():
                    (iconset / name).write_bytes(draw_lens(size, rounded=True))
                subprocess.check_call(["iconutil", "-c", "icns", "-o", str(darwin_dir / "code.icns"), str(iconset)])
        else:
            (darwin_dir / "code.png").write_bytes(png_1024)
            print("iconutil not found; wrote resources/darwin/code.png instead of code.icns")
    except Exception as error:
        (darwin_dir / "code.png").write_bytes(png_1024)
        print(f"Could not write ICNS ({error}); wrote resources/darwin/code.png")

    print("Wrote Lens icons under resources/{linux,win32,darwin}")


if __name__ == "__main__":
    main()
