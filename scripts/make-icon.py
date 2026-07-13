#!/usr/bin/env python3
# One-off asset generator for the macOS app icon (assets/AppIcon.icns). Run manually on macOS:
#   uv run --with pillow scripts/make-icon.py
# then `iconutil -c icns` turns the .iconset into the .icns (done by this script).
import os, subprocess, math
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# Rounded-square background with a vertical blue gradient (app accent family).
margin, radius = 88, 205
top, bot = (59, 130, 246), (29, 78, 216)   # #3b82f6 -> #1d4ed8
grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    gd.line([(0, y), (S, y)],
            fill=(int(top[0]+(bot[0]-top[0])*t), int(top[1]+(bot[1]-top[1])*t), int(top[2]+(bot[2]-top[2])*t), 255))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([margin, margin, S-margin, S-margin], radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

# Simple upward line chart in white with node dots — reads at every size.
d = ImageDraw.Draw(img)
pts = [(300, 690), (455, 540), (585, 620), (735, 360)]
d.line(pts, fill=(255, 255, 255, 255), width=48, joint="curve")
r = 34
for (x, y) in pts:
    d.ellipse([x-r, y-r, x+r, y+r], fill=(255, 255, 255, 255))
# little green up-tick accent on the last node (on-brand "positive")
gx, gy = pts[-1]
d.ellipse([gx-r, gy-r, gx+r, gy+r], fill=(52, 199, 123, 255))  # #34c77b

os.makedirs("assets", exist_ok=True)
iconset = "assets/AppIcon.iconset"
os.makedirs(iconset, exist_ok=True)
sizes = [16, 32, 64, 128, 256, 512, 1024]
def save(px, name):
    img.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
save(16, "icon_16x16.png");     save(32, "icon_16x16@2x.png")
save(32, "icon_32x32.png");     save(64, "icon_32x32@2x.png")
save(128, "icon_128x128.png");  save(256, "icon_128x128@2x.png")
save(256, "icon_256x256.png");  save(512, "icon_256x256@2x.png")
save(512, "icon_512x512.png");  save(1024, "icon_512x512@2x.png")
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", "assets/AppIcon.icns"], check=True)
import shutil; shutil.rmtree(iconset)
print("wrote assets/AppIcon.icns")
