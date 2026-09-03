"""
The motor on its own clock.

A machine does not advance because a master polled it. Stepping the plant inside
the read path ties the physics to the poll rate: a slow master gets a drive that
ramps in lumps, a fast one gets a different drive, and nothing happens at all
while nobody is looking. Both are wrong, and neither is visible until an
operator wonders why the same setpoint behaves differently on two machines.

So the plant runs in a daemon thread at a fixed cadence, and Modbus becomes what
it is on the device: a window. A read samples the machine, a write moves the
command, and the shaft keeps turning between them.
"""

import threading, time
from .command import Command
from .plant import Plant

#------------------------------------------------------------------------------------------ Cadence

# How often the thread wakes. Under the detector's own 10ms tick, so the takeover
# FSM still sees every window it is entitled to.
PERIOD_s = 0.01
# What the integrator accepts from a stalled thread: a laptop lid, a debugger or
# a loaded host must not hand the plant a multi-second leap that would ramp
# straight through its own limits.
STEP_MAX_s = 0.2

#------------------------------------------------------------------------------------------- Runner

class Runner:
  """Owns the plant and the thread that turns it. `scale` is model seconds per
  wall second: the physics does not care, the sub-step is fixed, and a bench that
  waits in model time gets its answers that many times sooner."""
  def __init__(self, plant:Plant=None, period:float=PERIOD_s, scale:float=1.0):
    self.plant = plant or Plant()
    self.period = period
    self.scale = max(0.01, scale)
    self.elapsed = 0.0  # model seconds since the runner started
    # Reentrant, because the transport takes it once and then calls back in to
    # hand over a command while it still holds it.
    self.lock = threading.RLock()
    self.ticks = 0
    self._cmd = Command()
    self._stop = threading.Event()
    self._thread = threading.Thread(target=self._loop, name="ectra-motor", daemon=True)
    self._thread.start()

  def send(self, cmd:Command):
    """Hand over the next command. Swapped whole, so the plant never reads half
    of one tick's intent and half of the next."""
    with self.lock: self._cmd = cmd

  def close(self):
    """Stop turning. The thread is a daemon, so this is a courtesy rather than a
    requirement for the process to exit."""
    self._stop.set()

  def _loop(self):
    last = time.monotonic()
    while not self._stop.wait(self.period):
      now = time.monotonic()
      dt = min(now - last, STEP_MAX_s) * self.scale
      last = now
      with self.lock:
        self.plant.step(self._cmd, dt)
        self.elapsed += dt
        self.ticks += 1
