"""
Cabbage → Tree Logo Generator

Params:
  --src          Input image path
  --out          Output PNG path (default: logo.png)
  --size         Output size in px (default: 1024)
  --blur         Gaussian blur radius — bigger = simpler shapes (default: 7)
  --morph        Morphology disk radius — bigger = smoother edges (default: 5)
  --min-area     Remove blobs smaller than this (px) (default: 800)
  --dark         Dark color hex (default: #2A0A34)
  --mid          Mid color hex (default: #943790)
  --light        Light color hex (default: #F5EEE6)
  --border       Border width, 0 = no border (default: 5)
  --no-symmetry  Disable left-right mirror

Examples:
  py logo.py --src cabbage.png --blur 5 --morph 3
  py logo.py --src cabbage.png --blur 12 --morph 8 --min-area 3000
  py logo.py --src cabbage.png --dark "#1a0a2e" --mid "#7b2d8e" --light "#ffffff"
"""

import argparse
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
from sklearn.cluster import KMeans
from skimage import morphology

def hex2rgb(h):
  h = h.lstrip('#')
  return [int(h[i:i+2], 16) for i in (0, 2, 4)]

def main():
  p = argparse.ArgumentParser(description="Cabbage → Tree Logo")
  p.add_argument("--src", required=True, help="Input image")
  p.add_argument("--out", default="logo.png", help="Output PNG")
  p.add_argument("--size", type=int, default=1024)
  p.add_argument("--blur", type=float, default=7, help="Blur radius (bigger=simpler)")
  p.add_argument("--morph", type=int, default=5, help="Morphology disk (bigger=smoother)")
  p.add_argument("--min-area", type=int, default=800, help="Remove blobs < N px")
  p.add_argument("--dark", default="#2A0A34", help="Dark color hex")
  p.add_argument("--mid", default="#943790", help="Mid color hex")
  p.add_argument("--light", default="#F5EEE6", help="Light color hex")
  p.add_argument("--border", type=int, default=5, help="Border width (0=none)")
  p.add_argument("--no-symmetry", action="store_true", help="Disable mirror")
  args = p.parse_args()

  SIZE = args.size
  palette = np.array([hex2rgb(args.dark), hex2rgb(args.mid), hex2rgb(args.light)], dtype=np.uint8)

  img = Image.open(args.src).convert("RGB")
  w, h = img.size
  s = min(w, h)
  img = img.crop(((w-s)//2, (h-s)//2, (w+s)//2, (h+s)//2))
  img = img.resize((SIZE, SIZE), Image.LANCZOS)
  img = img.filter(ImageFilter.GaussianBlur(radius=args.blur))

  arr = np.array(img, dtype=np.float64)
  half = SIZE // 2

  # Symmetry
  if not args.no_symmetry:
    left = arr[:, :half, :]
    right = arr[:, half:, :][:, ::-1, :]
    avg = ((left + right) / 2).astype(np.uint8)
    arr = np.concatenate([avg, avg[:, ::-1, :]], axis=1)

  # K-means → 3 clusters
  pixels = arr.reshape(-1, 3).astype(np.float64)
  km = KMeans(n_clusters=3, n_init=10, random_state=42)
  labels = km.fit_predict(pixels)

  # Sort by brightness → dark=0, mid=1, light=2
  brightness = km.cluster_centers_.mean(axis=1)
  order = np.argsort(brightness)
  remap = np.zeros(3, dtype=int)
  for new, old in enumerate(order):
    remap[old] = new
  labels_map = remap[labels].reshape(SIZE, SIZE)

  # Morphological cleanup
  if args.morph > 0:
    disk = morphology.disk(args.morph)
    for i in range(3):
      region = (labels_map == i)
      region = morphology.opening(region, disk)
      region = morphology.closing(region, disk)
      if args.min_area > 0:
        region = morphology.remove_small_objects(region, max_size=args.min_area)
      labels_map[region] = i

  # Re-symmetrize after morphology
  if not args.no_symmetry:
    left_labels = labels_map[:, :half]
    labels_map = np.concatenate([left_labels, left_labels[:, ::-1]], axis=1)

  # Apply palette
  result = palette[labels_map].reshape(SIZE, SIZE, 3)

  # Circular mask
  Y, X = np.ogrid[:SIZE, :SIZE]
  c = SIZE // 2
  R = c - max(args.border, 2)
  mask = ((X - c)**2 + (Y - c)**2) <= R**2
  alpha = np.zeros((SIZE, SIZE), dtype=np.uint8)
  alpha[mask] = 255

  img_out = Image.fromarray(np.dstack([result, alpha]), 'RGBA')

  if args.border > 0:
    draw = ImageDraw.Draw(img_out)
    b = max(args.border, 2)
    draw.ellipse([b, b, SIZE-b-1, SIZE-b-1],
      outline=tuple(palette[0].tolist()) + (255,), width=args.border)

  img_out.save(args.out)
  print(f"Saved: {args.out} ({SIZE}x{SIZE})")

if __name__ == "__main__":
  main()