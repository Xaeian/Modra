// scripts/widgets/ectra.jsx

// Ectra V/f table tuner. The drive interpolates ModTab:* (96 points, m% over Hz)
// for its modulation index, so writing a cell outright is a step change on a
// spinning motor - edits are slewed in EC_SLEW increments instead.

const EC_PREFIX = "ModTab:";
const EC_KEY = "Auth:SecretKey";
const EC_ACCESS = "Auth:Access";
const EC_SETPOINT = "Ctrl:Setpoint";
// SECRET_KEY_ADMIN, ectra iv-ifc/reg.h. The table is admin-gated.
const EC_ADMIN = 0x5D8E41B3;

const EC_QUANT = 0.01;    // register quantum at scale 100
const EC_SLEW = 0.05;     // largest step the motor takes without a jolt
const EC_GAP_MS = 120;    // floor between writes, so a fast link cannot spin
const EC_ARM_MS = 3000;   // backoff on access, so a bad key is not a write storm

const EC_BUMPS = [0.01, 0.05, 0.1, 0.5, 1];
const EC_MEAS = ["MeasSlow:CurrAvg", "MeasSlow:PeakMax"];

const ecQuant = (v) => Math.round(v / EC_QUANT) * EC_QUANT;
const ecClamp = (v, reg) => Math.max(Reg.min(reg), Math.min(Reg.max(reg), v));
const ecShow = (name) => {
  const reg = Reg.byName(name), v = S.values[name];
  return (reg && v != null) ? Reg.display(reg, v) : "-";
};

const Ectra = {

  id: "ectra",
  title: "Ectra · V/f table",

  // Displayed values come from S.values only. The one piece of local state is
  // what the user asked for, never what the device holds.
  _pts: null, _src: null,
  _target: {},
  _slewing: false,
  _stepping: false,
  _pin: null,               // pinned point index; null follows the motor
  _bump: 0.1,
  _nextArm: 0,

  //---------------------------------------------------------- Catalog

  match(regs) {
    return regs.some(r => r.name === EC_KEY)
      && regs.filter(r => r.name.startsWith(EC_PREFIX)).length >= 8;
  },

  // The desc frequency is authoritative: names are rounded labels on a
  // non-uniform grid, so ModTab:37Hz actually sits at 36.87 Hz.
  points() {
    if(this._src !== S.regs) {
      this._src = S.regs;
      this._pts = S.regs
        .filter(r => r.name.startsWith(EC_PREFIX))
        .map(r => {
          const m = /at\s+([\d.]+)\s*Hz/i.exec(r.desc || "");
          return m ? { name: r.name, reg: r, hz: parseFloat(m[1]) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.hz - b.hz);
    }
    return this._pts;
  },

  nearest(hz) {
    const pts = this.points();
    let best = 0;
    for(let i = 1; i < pts.length; i++) {
      if(Math.abs(pts[i].hz - hz) < Math.abs(pts[best].hz - hz)) best = i;
    }
    return best;
  },

  // Feedback:RenderFreq is published untrimmed, so it shares the ModTab axis.
  focus() {
    const pts = this.points();
    if(!pts.length) return -1;
    if(this._pin != null) return Math.max(0, Math.min(pts.length - 1, this._pin));
    const hz = S.values["Feedback:RenderFreq"];
    return hz == null ? 0 : this.nearest(hz);
  },

  select(idx) { this._pin = idx; render(); },

  //---------------------------------------------------------- Setpoint

  // Bounds of the Hz slot, and only when the device confirmed that mode: the
  // backend encodes against the mode the device actually holds, so a staged but
  // unsent Ctrl:Mode would put a frequency into the % or rpm slot.
  setpoint() {
    const reg = Reg.byName(EC_SETPOINT);
    const i = reg ? Reg.ruleIndex(reg, true) : null;
    if(i == null || reg.unit[i] !== "Hz") return null;
    const slot = (v) => Array.isArray(v) ? v[i] : v;
    return { min: slot(reg.min) ?? 0, max: slot(reg.max) ?? 0 };
  },

  // Stepping starts from the setpoint register, which a write reads back, so
  // repeated clicks march on instead of recomputing from a stale feedback that
  // only the next poll refreshes. Null once the table outruns the slot range.
  nextSetpoint(dir) {
    const sp = this.setpoint();
    const hz = S.values[EC_SETPOINT] ?? S.values["Feedback:SetpointFreq"];
    if(!sp || hz == null) return null;
    const p = this.points()[this.nearest(hz) + dir];
    return (p && p.hz >= sp.min && p.hz <= sp.max) ? p : null;
  },

  // The drive ramps to a new setpoint on its own, so this writes once. Dropping
  // the pin lets the selection ride along as the motor gets there.
  async stepSetpoint(dir) {
    const p = this.nextSetpoint(dir);
    if(!p || !S.connected || this._stepping) return;
    this._stepping = true;
    this._pin = null;
    render();
    try { await writeNow({ [EC_SETPOINT]: p.hz }); }
    finally { this._stepping = false; render(); }
  },

  //---------------------------------------------------------- Access

  // Driven off the register: below admin, claim it. Self-healing, since the
  // drive drops back to guest whenever it restarts.
  arm() {
    const access = S.values[EC_ACCESS];
    if(!S.connected || access == null || access === "admin") return;
    if(Date.now() < this._nextArm) return;
    this._nextArm = Date.now() + EC_ARM_MS;
    writeNow({ [EC_KEY]: EC_ADMIN }).then(render);
  },

  //---------------------------------------------------------- Slew

  bump(delta) {
    const p = this.points()[this.focus()];
    if(!p || !S.connected) return;
    const from = this._target[p.name] ?? S.values[p.name];
    if(from == null) return;
    this._target[p.name] = ecClamp(ecQuant(from + delta), p.reg);
    this.slew();
    render();
  },

  // One write per step, every moving point batched into it, awaiting each write
  // so the loop paces itself to the link. Steps are measured against the
  // register, so a clamped or refused write is corrected, not compounded.
  async slew() {
    if(this._slewing) return;
    this._slewing = true;
    try {
      while(S.connected) {
        const patch = {};
        for(const [name, target] of Object.entries(this._target)) {
          const cur = S.values[name];
          // Both sides sit on the 0.01 grid, their difference does not:
          // 7.20-7.19 is 0.00999999... Count whole quanta, or the smallest
          // step rounds away to nothing.
          const gap = cur == null ? 0 : Math.round((target - cur) / EC_QUANT);
          if(!gap) { delete this._target[name]; continue; }
          patch[name] = ecQuant(cur + Math.sign(gap) * Math.min(EC_SLEW, Math.abs(gap) * EC_QUANT));
        }
        if(!Object.keys(patch).length) break;
        if(!await writeNow(patch)) break;
        // The write returns a read-back, so this asks the device whether it
        // took anything. If not, stop rather than hammer the bus.
        const landed = Object.entries(patch).some(([n, v]) => S.values[n] != null
          && Math.round((S.values[n] - v) / EC_QUANT) === 0);
        if(!landed) {
          alert.wrn("Device refused the write - check the access level");
          this.stop();
          break;
        }
        render();
        await new Promise(r => setTimeout(r, EC_GAP_MS));
      }
    }
    finally {
      this._slewing = false;
      if(!S.connected) this.stop();
      render();
    }
  },

  // Whatever is already written stays on the device.
  stop() { this._target = {}; render(); },

  //---------------------------------------------------------- View

  View() {
    this.arm();
    const pts = this.points();
    const i = this.focus();
    const p = pts[i];
    if(!p) return <div class="ec-empty">No ModTab registers in this map.</div>;

    const access = S.values[EC_ACCESS];
    const admin = access === "admin";
    const dev = S.values[p.name];
    const aim = this._target[p.name];
    const moving = Object.keys(this._target).length;

    return (
      <div class="ec">

        <div class="wg-row ec-bar">
          {!admin && <span class="ec-badge">🔒 {access ?? "-"}</span>}
          <span class="ec-stat">{S.values["Feedback:State"] ?? "-"}</span>
          <span class="ec-stat">{ecShow("Feedback:RenderFreq")} Hz</span>
          <span class="ec-stat">{ecShow("Feedback:ModIndex")} m%</span>
          <span class="wg-gap" />
          {moving > 0 &&
            <span class="ec-stat ec-moving">
              {this._slewing ? "▶" : "⏸"} {moving} pt slewing
            </span>}
          {moving > 0 &&
            <button class="ec-btn ec-warn" onClick={() => Ectra.stop()}
              title="Stop the slew, keep what is already written">■ Stop</button>}
        </div>

        <div class="ec-plot" ref={el => Ectra.paint(el, pts, i)}></div>

        <div class="wg-row">
          <button class="ec-btn" onClick={() => Ectra.select(i - 1)} disabled={i <= 0}>◀</button>
          <span class="ec-pt">
            <b>{p.hz.toFixed(2)} Hz</b>
            <i>{p.name}</i>
          </span>
          <button class="ec-btn" onClick={() => Ectra.select(i + 1)}
            disabled={i >= pts.length - 1}>▶</button>
          <button class={cls("ec-btn", this._pin == null && "on")}
            onClick={() => Ectra.select(null)}
            title="Follow the running point">🎯</button>

          <span class="wg-gap" />

          <button class="ec-big" disabled={!admin || !S.connected}
            onClick={() => Ectra.bump(-Ectra._bump)}>−</button>
          <span class="ec-val">
            <b>{dev == null ? "-" : Reg.display(p.reg, dev)}</b>
            {aim != null && <i>→ {Reg.display(p.reg, aim)}</i>}
            <u>m%</u>
          </span>
          <button class="ec-big" disabled={!admin || !S.connected}
            onClick={() => Ectra.bump(Ectra._bump)}>+</button>

          <span class="ec-chips">
            {EC_BUMPS.map(b =>
              <button class={cls("ec-chip", b === Ectra._bump && "on")}
                onClick={() => { Ectra._bump = b; render(); }}>{b}</button>)}
          </span>
        </div>

        <div class="wg-row ec-meas">
          <span class="ec-set">
            <i>{this.setpoint() ? "setpoint" : "setpoint · needs Hz mode"}</i>
            <button class="ec-btn" onClick={() => Ectra.stepSetpoint(-1)}
              disabled={!S.connected || this._stepping || !this.nextSetpoint(-1)}
              title="Drive to the previous breakpoint">◀</button>
            <b>{ecShow("Feedback:SetpointFreq")}</b><u>Hz</u>
            <button class="ec-btn" onClick={() => Ectra.stepSetpoint(1)}
              disabled={!S.connected || this._stepping || !this.nextSetpoint(1)}
              title="Drive to the next breakpoint">▶</button>
          </span>
          <span class="wg-gap" />
          {EC_MEAS.map(name => {
            const reg = Reg.byName(name);
            return (
              <span class="ec-meas-item">
                <i>{name.split(":")[1]}</i>
                <b>{ecShow(name)}</b>
                <u>{reg ? Reg.unit(reg) : ""}</u>
                <button class={cls("ec-chip", S.monitor.has(name) && "on")}
                  onClick={() => reg && toggleMonitor(reg)} title="Chart">📊</button>
              </span>
            );
          })}
        </div>

      </div>
    );
  },

  //---------------------------------------------------------- Plot

  // Whole table on a log frequency axis - 2 Hz to 655 Hz is 2.5 decades.
  // Injected as markup because the JSX runtime builds nodes with
  // createElement, which cannot make SVG. Markers are vertical lines: the
  // viewBox scales non-uniformly, so anything round would come out an ellipse.
  paint(el, pts, focus) {
    const W = 1000, H = 140, PAD = 8;
    const vals = pts.map(p => S.values[p.name]);
    const known = vals.filter(v => v != null);
    if(!known.length) { el.innerHTML = ""; return; }

    const lo = Math.min(...known), hi = Math.max(...known);
    const pad = Math.max((hi - lo) * 0.12, 0.5);
    const x0 = Math.log(pts[0].hz), x1 = Math.log(pts[pts.length - 1].hz);
    const X = (hz) => PAD + (Math.log(hz) - x0) / (x1 - x0) * (W - 2 * PAD);
    const Y = (v) => PAD + (hi + pad - v) / (hi - lo + 2 * pad) * (H - 2 * PAD);
    const vline = (cl, hz) => `<line class="${cl}" x1="${X(hz).toFixed(1)}" y1="0"`
      + ` x2="${X(hz).toFixed(1)}" y2="${H}"/>`;

    let d = "";
    pts.forEach((p, i) => {
      if(vals[i] == null) return;
      d += (d ? "L" : "M") + X(p.hz).toFixed(1) + " " + Y(vals[i]).toFixed(1) + " ";
    });

    const hz = S.values["Feedback:RenderFreq"];
    const live = (hz != null && hz >= pts[0].hz && hz <= pts[pts.length - 1].hz)
      ? vline("ec-live", hz) : "";
    // Click targets, each spanning half the gap to its neighbours.
    const hits = pts.map((p, i) => {
      const a = i === 0 ? PAD : (X(pts[i - 1].hz) + X(p.hz)) / 2;
      const b = i === pts.length - 1 ? W - PAD : (X(p.hz) + X(pts[i + 1].hz)) / 2;
      return `<rect class="ec-hit" data-i="${i}" x="${a.toFixed(1)}" y="0"`
        + ` width="${Math.max(1, b - a).toFixed(1)}" height="${H}"/>`;
    }).join("");

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
      + `<path class="ec-line" d="${d}"/>`
      + live + vline("ec-focus", pts[focus].hz) + hits
      + `</svg>`;

    el.onclick = (e) => {
      const hit = e.target.closest?.("[data-i]");
      if(hit) Ectra.select(Number(hit.dataset.i));
    };
  },
};

Widgets.register(Ectra);
