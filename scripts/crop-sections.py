"""Cut every section in design-library/<niche>/library.json out of its source image.

    python scripts/crop-sections.py            # all niches
    python scripts/crop-sections.py trades     # one niche

A crop's "src" is either a measured template slug (its reference-1..N.jpg slices are stitched back
into the full page) or an image file inside the niche folder. Crops are saved as
design-library/<niche>/sections/<id>.jpg, max 900px wide, so the generator can look at each
section it is asked to build.
"""
import json, sys
from pathlib import Path
from PIL import Image

LIB = Path(__file__).resolve().parent.parent / "design-library"
MAX_W, MAX_H = 900, 1100
pages = {}

def full_page(slug):
    if slug not in pages:
        parts = sorted((LIB / slug).glob("reference-*.jpg"), key=lambda p: int(p.stem.split("-")[1]))
        imgs = [Image.open(p).convert("RGB") for p in parts]
        page = Image.new("RGB", (imgs[0].width, sum(i.height for i in imgs)), "white")
        y = 0
        for i in imgs:
            page.paste(i, (0, y)); y += i.height
        pages[slug] = page
    return pages[slug]

def run(niche):
    lib = json.loads((LIB / niche / "library.json").read_text(encoding="utf8"))
    out = LIB / niche / "sections"
    out.mkdir(exist_ok=True)
    for s in lib["sections"]:
        c = s["crop"]
        src = c["src"]
        img = Image.open(LIB / niche / src).convert("RGB") if "." in src else full_page(src)
        x, y = c.get("x", 0), c["y"]
        w, h = c.get("w", img.width - x), c["h"]
        part = img.crop((x, y, min(img.width, x + w), min(img.height, y + h)))
        scale = min(1, MAX_W / part.width, MAX_H / part.height)
        if scale < 1:
            part = part.resize((round(part.width * scale), round(part.height * scale)), Image.LANCZOS)
        part.save(out / f"{s['id']}.jpg", quality=80, optimize=True)
    print(f"{niche}: {len(lib['sections'])} sections -> {out}")

for n in sys.argv[1:] or [p.parent.name for p in LIB.glob("*/library.json")]:
    run(n)
