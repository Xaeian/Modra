"""
Coupled ectra drive simulator, sitting beside the app rather than inside it.

`sim.py` walks every register on its own. That is right for an unknown map and
wrong for a drive, where turning a knob has to move the operating point.

This package models the loop instead, and it knows ectra register names on
purpose, which is exactly what `modbus.py` must never do.

Layers are acyclic, each answering for one thing:

- `curve.py` and `command.py` are leaves: table lookup, and one tick of intent.
- `machine.py` is the iron, the bridge and the shaft. It carries the machine's
  own TRUTH, separate from the `Motor:*` an operator typed in.
- `ramp.py`, `observer.py`, `detector.py` and `protect.py` are the control
  problem: where the frequency may go, what the estimator makes of the rotor,
  when the loop may close, and what ends a run.
- `plant.py` is the stage machine over those five, and the only place a verdict,
  a takeover and a fault meet.
- `meter.py` filters it twice, fast for control and slow for the trend, because
  nothing outside reads the machine raw.
- `runner.py` turns the shaft on its own thread, so the physics does not wait
  for a poll and does not run at the master's cadence.
- `binding.py` is the only file that names a register; `names.py` holds the names.
- `client.py` is the `SimulatedClient` seam and the tick cadence.

Example:
  >>> from ectra import EctraClient
  >>> if EctraClient.match(mb.id_map): mb.client = EctraClient(mb.id_map)
"""

from .client import EctraClient
from .command import Command
from .machine import Machine
from .plant import Plant
from .runner import Runner

__all__ = ["Command", "EctraClient", "Machine", "Plant", "Runner"]
