"""
Build the Revind app icon from revindlogo.png:
  - flood-fill the white background away from the corners (so the squircle's
    rounded corners come out transparent)
  - crop to the tile, then center it on a transparent canvas at the macOS
    safe-area scale (~80%), matching the other apps' icons
  - export every Tauri icon size + icon.icns / icon.ico + logo.png

Run:  python3 generate_revind_icon.py
"""

from PIL import Image, ImageFilter
from collections import deque
import os, subprocess, shutil

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_LOGO = os.path.join(os.path.dirname(SRC_DIR), "revindlogo.png")
DST_DIR = os.path.join(SRC_DIR, "src-tauri", "icons")
MASTER_SIZE = 1024
SAFE_SCALE = 0.805     # squircle body / canvas, per Apple's icon grid
RIM_THRESHOLD = 200    # treat >this on all channels as background (eats the light rim)
EDGE_ERODE = 2         # px to shrink the tile so its edge lands on dark pixels


def build_master(src_path, hue_shift=0.0):
    """Return a MASTER_SIZE transparent-canvas RGBA icon from src_path.

    hue_shift rotates the hue (degrees) of every coloured pixel; the dark
    tile background is left untouched.
    """
    im = Image.open(src_path).convert("RGBA")
    w, h = im.size
    px = im.load()

    def is_bg(p):
        return (p[0] > RIM_THRESHOLD and p[1] > RIM_THRESHOLD
                and p[2] > RIM_THRESHOLD)

    # Flood-fill the white background (incl. its light anti-aliased rim) from
    # the four corners, build an alpha mask, then erode it a couple of pixels
    # so the squircle edge lands on dark tile pixels -> no light halo line.
    seen = bytearray(w * h)
    dq = deque([(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
    while dq:
        x, y = dq.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i] or not is_bg(px[x, y]):
            continue
        seen[i] = 1
        dq.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])

    mask = Image.new("L", (w, h), 0)
    mp = mask.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if not seen[row + x]:
                mp[x, y] = 255
    if EDGE_ERODE:
        mask = mask.filter(ImageFilter.MinFilter(EDGE_ERODE * 2 + 1))
    im.putalpha(mask)
    tile = im.crop(im.getbbox())

    if hue_shift:
        tile = recolor(tile, hue_shift)

    # Center the tile on a square transparent canvas at the safe-area scale.
    target = int(MASTER_SIZE * SAFE_SCALE)
    tw, th = tile.size
    scale = target / max(tw, th)
    tile = tile.resize((max(1, round(tw * scale)), max(1, round(th * scale))),
                       Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), (0, 0, 0, 0))
    canvas.paste(tile, ((MASTER_SIZE - tile.width) // 2,
                        (MASTER_SIZE - tile.height) // 2), tile)
    return canvas


def recolor(img, hue_shift):
    """Rotate hue of coloured pixels by hue_shift degrees; keep dark tile."""
    import colorsys
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 10:
                continue
            hue, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if v < 0.22 or s < 0.06:   # dark tile / near-gray: leave as-is
                continue
            hue = (hue + hue_shift / 360.0) % 1.0
            nr, ng, nb = colorsys.hsv_to_rgb(hue, s, v)
            px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return img


def export(master, dst_dir, also_logo=None):
    os.makedirs(dst_dir, exist_ok=True)
    sizes = {
        "icon.png": 512, "32x32.png": 32, "64x64.png": 64,
        "128x128.png": 128, "128x128@2x.png": 256,
        "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310, "StoreLogo.png": 50,
    }
    for name, sz in sizes.items():
        master.resize((sz, sz), Image.Resampling.LANCZOS).save(
            os.path.join(dst_dir, name), "PNG")

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico = [master.resize((s, s), Image.Resampling.LANCZOS) for s in ico_sizes]
    ico[0].save(os.path.join(dst_dir, "icon.ico"), format="ICO",
                sizes=[(s, s) for s in ico_sizes], append_images=ico[1:])

    iconset = os.path.join(dst_dir, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for name, sz in {"icon_16x16.png": 16, "icon_16x16@2x.png": 32,
                     "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
                     "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
                     "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
                     "icon_512x512.png": 512, "icon_512x512@2x.png": 1024}.items():
        master.resize((sz, sz), Image.Resampling.LANCZOS).save(
            os.path.join(iconset, name), "PNG")
    try:
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o",
                        os.path.join(dst_dir, "icon.icns")], check=True)
    except Exception as e:
        print(f"  icns: {e}")
    shutil.rmtree(iconset, ignore_errors=True)

    if also_logo:
        master.resize((512, 512), Image.Resampling.LANCZOS).save(also_logo, "PNG")


if __name__ == "__main__":
    print("Building Revind master from", SRC_LOGO)
    master = build_master(SRC_LOGO)
    master.save(os.path.join(SRC_DIR, "revind_icon_master.png"), "PNG")
    export(master, DST_DIR, also_logo=os.path.join(SRC_DIR, "logo.png"))
    print("Done -> video-editor/src-tauri/icons + logo.png")
