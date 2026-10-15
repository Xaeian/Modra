"""
Transport seam: a `SimulatedClient` whose modelled registers come from the plant.

A window onto a machine that is already running, not the thing that runs it.
Physics lives in `Machine`, control in `Plant`, the clock in `Runner`, register names in `Binding`.
"""

import time
from sim import SimulatedClient, register
from .binding import Binding
from .machine import Machine
from .plant import Plant
from .runner import Runner

# How often the register image is rebuilt.
# The machine runs on its own clock,
# so resampling it faster than the device's own measurement window buys nothing.
# The COMMAND is not throttled with it: that is the control path,
# and a knob has to reach the machine when it is turned, not when the next poll comes due.
SNAP_MIN_s = 0.05

#------------------------------------------------------------------------------------------- Client

class EctraClient(SimulatedClient):
  """Drop-in for `SimulatedClient` on a regmap shaped like ectra's."""
  match = staticmethod(Binding.match)

  def __init__(self, id_map:dict, speed:float=1.0, lockstep:bool=False):
    self.runner = None
    self.speed = max(0.01, speed)
    self.lockstep = lockstep
    self._seen = None # the model time of the last register image, in lockstep
    super().__init__(id_map)
    # In lockstep the model's time moves only in the caller's waits: a link delay is wall time lost
    if lockstep: self.latency = 0.0
    self._attach(id_map)

  def reattach(self, id_map:dict):
    super().reattach(id_map)
    self._attach(id_map)

  def _attach(self, id_map:dict):
    """
    Bind to a map. The MACHINE survives it:
    a map reload is the master changing its mind about names, not the motor stopping.
    """
    self.bind = Binding(id_map)
    self._mode_rid = self.bind.rid.get("Ctrl:Mode")
    self._setpoint_rid = self.bind.rid.get("Ctrl:Setpoint")
    self._iq_max_rid = self.bind.rid.get("Foc:IqMax")
    self._curr_rms_rid = self.bind.rid.get("Thresh:CurrRms")
    if self.runner is None:
      self.runner = Runner(Plant(Machine()), scale=self.speed, lockstep=self.lockstep)

  def close(self):
    self.runner.close()
    super().close()

  async def write_registers(self, address:int, values:list, device_id:int=1):
    """
    The drive zeroes the setpoint whenever `Ctrl:Mode` is written,
    so a mode swap cannot inherit a number that meant something else.
    Reproduced here, or leaving `off` would fling the drive back at a stale command.
    """
    out = await super().write_registers(address, values, device_id)
    touched = self._mode_rid is not None and address <= self._mode_rid < address + len(values)
    if touched and self._setpoint_rid is not None: self.values[self._setpoint_rid] = 0
    # The current loop's clamp has to stop BELOW the trip,
    # or a loop riding its own limit overshoots into the fault on every step.
    # Written back to the register, so the operator sees the cap take.
    if self._iq_max_rid is not None and self._curr_rms_rid is not None:
      ceil = self.values.get(self._curr_rms_rid, 0) * 90 // 100
      if ceil and self.values.get(self._iq_max_rid, 0) > ceil:
        self.values[self._iq_max_rid] = ceil
    # Intent changed, so the machine hears it now:
    # waiting for the next read would make a knob answer at the poll rate,
    # not when it was turned.
    self._push()
    return out

  def _push(self):
    """Hand the machine the intent the registers now carry."""
    with self.runner.lock:
      self.runner.send(self.bind.command(self.values, self.runner.plant.ramp.hz))

  def _tick_all(self):
    """
    Give the running machine this poll's intent, then read it back.

    No physics here. The plant advanced between calls:
    on its own clock, or in lockstep while the caller waited.
    So a master that polls twice as fast sees the same drive twice as often, not a different one.
    The intent goes over on every read, in lockstep once per wait.
    Only the register image is throttled, because rebuilding it is the expensive half,
    and the machine does not need a reader to make progress.
    """
    if self.runner.error: raise RuntimeError(f"model stopped: {self.runner.error}")
    if self.lockstep:
      # The model moved only if the caller waited: the intent and a new image then,
      # a write hands its intent over by itself
      if self.runner.elapsed == self._seen: return
      self._seen = self.runner.elapsed
      self._push()
    else:
      self._push()
      now = time.time()
      if now - self._last_tick < SNAP_MIN_s / self.speed: return
      self._last_tick = now
    with self.runner.lock:
      out = self.bind.telemetry(self.runner.plant, self.values)
    # Every reading is the model's or a sentinel, never a value a generic walk left behind
    for rid, raw in out.items():
      self.values[rid] = raw & 0xFFFF

# Offered to any map `Binding.match` recognises. Whether this package is loaded
# at all is the deployment's call, not this file's and not the app's.
register(EctraClient)
