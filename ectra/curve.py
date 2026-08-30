"""
Table lookup, the way `shared.c` does it.

A leaf: the anchor tables and the ramp rates are both read through `interp`, and
they part ways only below the first anchor.
"""

#-------------------------------------------------------------------------------------------- Curve

def interp(anchors:list, x:float, to_zero:bool=False) -> float|None:
  """
  Piecewise-linear lookup on a sorted `(x, y)` list, flat past the last anchor.

  Below the FIRST anchor the two table families part ways. A quantity falls
  linearly to zero, because a machine at standstill needs no volts and no amps.
  A rate holds its first anchor flat, because a tempo faded toward zero would
  make leaving standstill take a logarithm.
  """
  if not anchors: return None
  x0, y0 = anchors[0]
  if x <= x0: return y0 * x / x0 if to_zero and x0 else y0
  if x >= anchors[-1][0]: return anchors[-1][1]
  for (xa, ya), (xb, yb) in zip(anchors, anchors[1:]):
    if xa <= x <= xb: return ya + (yb - ya) * (x - xa) / (xb - xa)
  return anchors[-1][1]

def clamp(v:float, lo:float, hi:float) -> float:
  """Bounded value, low edge winning an inverted pair."""
  return lo if v < lo else hi if v > hi else v
