"""Rasterize assets/conarium-mark.svg geometry. No redesign — same circles, same #fff."""
from __future__ import annotations

import struct
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
# viewBox 0 0 32 32 — exact numbers from the extracted mark
CX, CY, R_RING, STROKE, R_DOT = 16.0, 16.0, 9.0, 1.7, 3.4
FILL = (255, 255, 255, 255)


def render(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = size / 32.0
    cx, cy = CX * s, CY * s
    r = R_RING * s
    sw = max(STROKE * s, 1.0)
    # Pillow ellipse outline is centered on the path; match SVG stroke.
    outer = (cx - r - sw / 2, cy - r - sw / 2, cx + r + sw / 2, cy + r + sw / 2)
    inner = (cx - r + sw / 2, cy - r + sw / 2, cx + r - sw / 2, cy + r - sw / 2)
    draw.ellipse(outer, fill=FILL)
    draw.ellipse(inner, fill=(0, 0, 0, 0))
    rd = R_DOT * s
    draw.ellipse((cx - rd, cy - rd, cx + rd, cy + rd), fill=FILL)
    return img


def png_bytes(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def write_icns(path: Path, pngs: dict[bytes, bytes]) -> None:
    """Minimal ICNS with PNG media (icp5/icp6/ic07/ic08/ic09)."""
    chunks = b""
    for typ, data in pngs.items():
        chunks += typ + struct.pack(">I", 8 + len(data)) + data
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(chunks)) + chunks)


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    sizes = (16, 32, 48, 64, 128, 256, 512)
    rasters = {n: render(n) for n in sizes}
    rasters[512].save(ASSETS / "conarium-mark-512.png")
    rasters[256].save(ASSETS / "conarium-mark.ico", format="ICO", sizes=[(n, n) for n in (16, 32, 48, 64, 128, 256)])
    write_icns(
        ASSETS / "conarium-mark.icns",
        {
            b"icp5": png_bytes(rasters[32]),
            b"icp6": png_bytes(rasters[64]),
            b"ic07": png_bytes(rasters[128]),
            b"ic08": png_bytes(rasters[256]),
            b"ic09": png_bytes(rasters[512]),
        },
    )
    print("wrote", ASSETS / "conarium-mark-512.png")
    print("wrote", ASSETS / "conarium-mark.ico")
    print("wrote", ASSETS / "conarium-mark.icns")


if __name__ == "__main__":
    main()
