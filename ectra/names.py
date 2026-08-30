"""
Every register name the package knows, in one place.

A rename in `regs.csv` lands here and in `binding.py`, and nowhere else.
"""

import re

#-------------------------------------------------------------------------------------- Recognition

# Presence of all of these is what "shaped like ectra" means. Anything missing
# and the caller falls back to the generic walk, rather than half-model a
# stranger's map.
REQUIRED = (
  "Ctrl:Mode", "Ctrl:Setpoint", "Drive:Mode", "Motor:PolePairs",
  "Drive:Stage", "Feedback:RenderFreq",
  "Obs:DtComp", "Obs:Bias", "Sync:Lock", "Foc:EntryFreq", "Foc:LockErr",
)

# `MODBUS_Access` in `proto/auth.c`: the level a written key unlocks, and guest
# for anything else. Reproduced rather than approximated, because a level that
# does not follow the key teaches the operator to ignore the padlock.
AUTH_KEYS = {0x5D8E41B3: "admin", 0xA3F7C29E: "service", 0x04D20000: "user"}

#--------------------------------------------------------------------------------- Curves and tiers

# `Group:<n>Hz` rows are a curve sampled on their own frequency grid.
CURVE_GROUPS = ("Volt", "Curr", "Rise", "Fall")
CURVE_NAME = re.compile(r"(\d+(?:\.\d+)?)Hz$")

# The two measurement tiers carry the same reading here. The device filters one
# fast and one slow; a model has no second filter to be slower than, and a
# reader of either tier must not find a different number there.
TIERS = ("Meas", "MeasCtrl")
METERS = (
  "Freq", "Speed", "CurrU", "CurrV", "CurrW", "CurrAvg",
  "PeakU", "PeakV", "PeakW", "PeakMax",
  "Temp", "ExTemp", "DcBus", "Flyback", "Ripple", "Power",
)

#----------------------------------------------------------------------------------------- Coverage

# Readings with no model behind them that still have a sensible standing value.
STANDING = {
  "Version:Abi": 1, "Counter:PowerUp": 1, "Counter:Watchdog": 0,
  "Counter:RS485": 0, "Counter:Link": 0, "Journal:Count": 0,
  "Digital:InputState": 0, "Digital:RelayState": 0,
  "AnalogInput:Value": 0, "AnalogInput:SensValue": 0, "Flow:Value": 0,
  "Pwm:IsrSlack": 900,
}

# Everything the plant answers for. What is left over publishes its sentinel:
# the device says "no reading" rather than a number that looks valid, and a
# value frozen where a generic walk left it is exactly such a number.
#
# `Foc:Guard*` and the `Fault:*` snapshots are deliberately absent. Both hold
# the evidence of something that happened, and before it does the device has no
# reading to give; a zero there would read as a verdict of its own.
OWNED = (
  "Feedback:RenderFreq", "Feedback:RenderSpeed", "Feedback:SetpointFreq",
  "Feedback:SetpointSpeed", "Feedback:Volt", "Feedback:ModIndex", "Feedback:State",
  "Drive:Stage", "Bus:Peak", "Bus:Max", "Bus:Lag", "Pwm:DutyPeak",
  "Estim:Freq", "Estim:FieldAngle", "Estim:Id", "Estim:Iq",
  "Obs:OmegaHat", "Obs:AngleErr", "Obs:Bias",
  "Sync:Err", "Sync:ErrPeak", "Sync:Lock", "Sync:LockPeak",
  "Sync:Takeovers", "Sync:Fallbacks",
  "Foc:Flags", "Foc:Vd", "Foc:Vq", "Foc:IqCmd",
  "Freeze:State", "Freeze:HoldCount", "Brake:RegenCount",
  "Fault:Code", "Fault:PeakEvents", "Counter:Hours",
  "Link:ConfigTarget", "Link:ConfigApplied", "Auth:Access",
) + tuple(f"{t}:{m}" for t in TIERS for m in METERS) + tuple(STANDING)
