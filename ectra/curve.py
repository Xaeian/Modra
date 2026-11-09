"""
Table lookup, the way the drive looks its tables up.

A leaf: the anchor tables and the ramp rates are both read through `interp`.
"""

#-------------------------------------------------------------------------------------------- Curve

def interp(anchors:list, x:float) -> float|None:
  """Piecewise-linear lookup on a sorted `(x, y)` list, flat past both ends."""
  if not anchors: return None
  x0, y0 = anchors[0]
  if x <= x0: return y0
  if x >= anchors[-1][0]: return anchors[-1][1]
  for (xa, ya), (xb, yb) in zip(anchors, anchors[1:]):
    if xa <= x <= xb: return ya + (yb - ya) * (x - xa) / (xb - xa)
  return anchors[-1][1]

def clamp(v:float, lo:float, hi:float) -> float:
  """Bounded value, low edge winning an inverted pair."""
  return lo if v < lo else hi if v > hi else v
