// scripts/widgets/ectra-tables.jsx

// The four curve tables, as curves.
//
// `Volt:40Hz` is one number in the grid and one point on a shape; the grid can
// show the number and never the shape, which is the only reason this panel
// exists. Drag a dot, and the write lands when the mouse comes up.
//
// The four are not interchangeable and the editor does not pretend they are.
// `Volt` and `Curr` are QUANTITIES: below their first anchor they fall linearly
// to zero, because a machine at standstill needs no volts and no amps, and a
// live reading rides on each of them. `Rise` and `Fall` are RATES on a coarser
// grid: below their first anchor they hold it flat, because a tempo faded
// toward zero would make leaving standstill take a logarithm, and nothing
// reports a tempo back, so they carry no working point.
//
// The guide lives in `ectra-guide.jsx`. Nothing here knows about stages: a
// table is a table whichever step of the procedure is open.

const EC_TABLES = ["Volt", "Curr", "Rise", "Fall"];
const EC_TAB_KEY = "modra.ectra.tab";
const EC_HIST_MAX = 20;

// How much of the x axis is the anchor grid rather than the frequency. A plain
// log axis crowds the top: this table gives its first three anchors a third of
// the width and its last fourteen barely more. Ordinal spacing spreads them
// evenly but stops being a frequency axis, so the working point would no longer
// sit where the drive is. 0 is pure log, 1 is pure grid.
const EC_X_EVEN = 0.65;

// The live reading that rides on a table, where one exists. Measured, not
// commanded: `Feedback:Volt` is the phase voltage the modulation actually put
// out and `MeasCtrl:CurrAvg` is the current three phases actually drew, so the
// dot sits where the machine is rather than where it was told to be. Comparing
// the table against its own command would only ever prove arithmetic.
const EC_LIVE = { Volt: "Feedback:Volt", Curr: "MeasCtrl:CurrAvg" };

const ecNum = (name) => {
  const v = S.values[name];
  return typeof v === "number" ? v : null;
};

// Clamp to the register's bounds and snap to its quantum: what a write can hold.
const ecQuant = (reg, v) =>
  Reg.snap(Math.max(Reg.min(reg), Math.min(Reg.max(reg), v)), Reg.step(reg));

const EctraTables = {

  id: "ectra-tables",
  title: "Ectra · Tables",
  icon: "📐",

  _busy: false,       // a curve write in flight
  _ghost: true,       // draw the device curve under the edited one
  _tab: EC_TABLES[0],
  _drag: -1,
  _from: null,
  _preview: null,     // device curve held from grab until the write lands
  _hist: [],
  _redo: [],
  _bound: null,       // connection the history belongs to
  _cv: null,
  _geo: null,         // paint-time transforms, reused for hit-testing
  _hoverEl: null,

  // Another widget asking for a table by name. Still no idea what a stage is:
  // this only knows how to be told which of its four to show.
  receive(msg) {
    if(!EC_TABLES.includes(msg?.table)) return false;
    this.setTab(msg.table);
    return true;
  },

  match(regs) {
    return EC_TABLES.some(t => regs.some(r => r.name.startsWith(t + ":")));
  },

  pts() {
    if(this._ptsTab !== this._tab || this._ptsSrc !== S.regs) {
      this._ptsTab = this._tab;
      this._ptsSrc = S.regs;
      this._pts = S.regs
        .map(r => ({ r, m: r.name.startsWith(this._tab + ":")
          && /:(\d+(?:\.\d+)?)Hz$/.exec(r.name) }))
        .filter(x => x.m)
        .map(x => ({ name: x.r.name, reg: x.r, hz: +x.m[1] }))
        .sort((a, b) => a.hz - b.hz);
    }
    return this._pts;
  },

  setTab(t) {
    if(t === this._tab) return;
    this._tab = t;
    this._preview = null;
    this._drag = -1;
    try { localStorage.setItem(EC_TAB_KEY, t); } catch(e) { /* per-session */ }
    render();
  },

  // What a point stands at: the staged edit where there is one, the device value
  // otherwise. The same precedence a grid row shows, so a pending change is a
  // curve you can see rather than a number hidden in another panel.
  _at(name) { return name in S.dirty ? S.dirty[name] : ecNum(name); },

  _shown(pts) { return pts.map(p => this._at(p.name)); },

  // What the device reports, staging ignored. Drawn under the editable curve so
  // a pending edit is a distance you can see rather than a claim: with auto-send
  // off the two part company the moment you move a dot, and the gap between them
  // is exactly what `Send` is about to close.
  _device(pts) { return pts.map(p => ecNum(p.name)); },

  toggleGhost() {
    this._ghost = !this._ghost;
    render();
  },

  // The one path a curve edit takes, so dragging a dot behaves like typing in a
  // grid row: stage it, and let `auto-send` decide whether it also goes out now.
  // With auto-send off the change waits with every other pending edit and
  // leaves on the next Send, which is the whole point of having the switch.
  //
  // Returns false only when a send was tried and refused, so the caller knows
  // whether the edit is really standing.
  async _apply(patch) {
    for(const [name, val] of Object.entries(patch)) {
      const reg = Reg.byName(name);
      if(reg) editSilent(reg, val);
    }
    if(!S.serial?.autosend || !S.connected) { render(); return true; }
    this._busy = true;
    render();
    try {
      if(!await writeNow(patch)) return false;
      // The device now holds these, so they are no longer pending.
      for(const name of Object.keys(patch)) delete S.dirty[name];
      return true;
    }
    finally {
      this._busy = false;
      render();
    }
  },

  // One batch per gesture; its pre-image arms undo only once the edit stands.
  async _commit(pts, from, target) {
    const patch = {}, prev = {};
    pts.forEach((p, i) => {
      if(target[i] != null && from[i] != null && !Reg.same(target[i], from[i])) {
        patch[p.name] = target[i];
        prev[p.name] = from[i];
      }
    });
    if(!Object.keys(patch).length) { this._preview = null; render(); return; }
    const ok = await this._apply(patch);
    this._preview = null;
    if(ok) {
      this._hist.push(prev);
      if(this._hist.length > EC_HIST_MAX) this._hist.shift();
      this._redo.length = 0;
    }
    render();
  },

  // One gentle pass toward the neighbours' chord, weighted by the real Hz
  // spacing of the non-uniform grid. Endpoints never move - they anchor
  // standstill and top-end behaviour on the live drive - and each point stays
  // inside the span of its neighbours, so a pass cannot mint a new extreme.
  // Repeated clicks smooth further, each one written and undoable.
  smooth() {
    const pts = this.pts();
    const from = this._shown(pts);
    if(from.length < 3 || from.some(v => v == null)) return;
    const target = from.slice();
    for(let i = 1; i < pts.length - 1; i++) {
      const t = (pts[i].hz - pts[i - 1].hz) / (pts[i + 1].hz - pts[i - 1].hz);
      const chord = from[i - 1] + (from[i + 1] - from[i - 1]) * t;
      target[i] = ecQuant(pts[i].reg, (from[i] + chord) / 2);
    }
    this._commit(pts, from, target);
  },

  async _step(fromStack, toStack) {
    const patch = fromStack.pop();
    if(!patch || this._busy) return;
    // The inverse is what is standing now, staged or written alike: undoing a
    // pending edit has to put back what the curve showed, not what the device
    // happens to still hold.
    const inverse = {};
    for(const n of Object.keys(patch)) inverse[n] = this._at(n);
    if(await this._apply(patch)) toStack.push(inverse);
    else fromStack.push(patch);
    render();
  },

  // One persistent canvas reparented into each render's slot - the same trick
  // Monitor uses. A fresh canvas per render is blank until painted, and with
  // the ref firing on a detached 0x0 node that blank frame flickers twice a
  // second. The old bitmap stays on screen until the deferred repaint lands.
  _slot(el) {
    if(!el) return;
    if(!this._cv) {
      const cv = document.createElement("canvas");
      cv.className = "ec-cv";
      cv.onmousedown = (e) => this._down(e);
      cv.onmousemove = (e) => this._move(e);
      cv.onmouseup = () => this._up();
      cv.onmouseleave = () => this._cancel();
      this._cv = cv;
    }
    el.appendChild(this._cv);
    requestAnimationFrame(() => this._paint());
  },

  _cancel() {
    // Leaving mid-drag discards the gesture - nothing was written yet.
    this._drag = -1;
    this._preview = null;
    if(this._cv) this._cv.style.cursor = "crosshair";
    this._paint();
  },

  _xy(e) {
    const r = this._cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  },

  _findPt(mx, my) {
    const g = this._geo;
    if(!g) return -1;
    let best = -1, bestD = 24;
    g.pts.forEach((p, i) => {
      if(g.cur[i] == null) return;
      const d = Math.hypot(g.toX(p.hz) - mx, g.toY(g.cur[i]) - my);
      if(d < bestD) { bestD = d; best = i; }
    });
    return best;
  },

  _down(e) {
    if(this._busy || !S.connected) return;
    const i = this._findPt(...this._xy(e));
    if(i >= 0) {
      this._drag = i;
      this._from = this._geo.cur.slice();
      this._cv.style.cursor = "grabbing";
    }
  },

  _move(e) {
    const g = this._geo;
    if(!g) return;
    const [mx, my] = this._xy(e);
    if(this._drag >= 0) {
      const i = this._drag;
      this._preview = this._from.slice();
      this._preview[i] = ecQuant(g.pts[i].reg, g.fromY(my));
      this._paint();
    }
    else this._cv.style.cursor = this._findPt(mx, my) >= 0 ? "grab" : "crosshair";
    if(this._hoverEl) {
      const i = this._drag >= 0 ? this._drag : this._findPt(mx, my);
      this._hoverEl.textContent = i >= 0
        ? `${g.pts[i].name} = ${(this._preview || g.cur)[i]?.toFixed(2)}`
        : "";
    }
  },

  _up() {
    if(this._drag < 0) return;
    const pts = this.pts();
    const from = this._from, target = this._preview;
    this._drag = -1;
    this._cv.style.cursor = "crosshair";
    if(target) this._commit(pts, from, target);
  },

  _paint() {
    const el = this._cv;
    if(!el) return;
    const rect = el.getBoundingClientRect();
    if(!rect.width) return;  // still detached: keep the last frame
    const pts = this.pts();
    if(!pts.length) return;
    const ctx = el.getContext("2d");
    const dpr = devicePixelRatio || 1;
    el.width = rect.width * dpr;
    el.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width, H = rect.height;
    const P = { l: 44, r: 12, t: 8, b: 18 };
    const css = getComputedStyle(document.documentElement);
    const C = {
      grid: css.getPropertyValue("--border").trim() || "#404040",
      text: css.getPropertyValue("--text-muted").trim() || "#888",
      edit: css.getPropertyValue("--accent").trim() || "#0d6efd",
      dot: css.getPropertyValue("--bg").trim() || "#fff",
      live: "#2e9e5b",
      ghost: css.getPropertyValue("--text-muted").trim() || "#888",
    };

    const cur = this._preview || this._shown(pts);
    const dev = this._device(pts);
    const liveX = ecNum("Feedback:RenderFreq");
    const liveY = EC_LIVE[this._tab] ? ecNum(EC_LIVE[this._tab]) : null;

    // The x axis is the table's own grid blended with frequency.
    //
    // Pure log still crowds the top: this table gives its first three anchors a
    // third of the width and the last fourteen barely more. Pure ordinal spacing
    // spreads every anchor equally but stops being a frequency axis, so the
    // working point would no longer sit where the drive actually is. Mixing them
    // keeps both: anchors you can hit, on an axis that still reads as Hz.
    const x0 = Math.log(pts[0].hz), x1 = Math.log(pts.at(-1).hz);
    const pw = W - P.l - P.r, ph = H - P.t - P.b;
    const last = pts.length - 1;
    // Ordinal position of any frequency, interpolated between its two anchors,
    // so the blend stays continuous and monotone between them.
    const ord = (hz) => {
      if(hz <= pts[0].hz) return 0;
      if(hz >= pts[last].hz) return 1;
      let i = 0;
      while(i < last && pts[i + 1].hz < hz) i++;
      const span = pts[i + 1].hz - pts[i].hz;
      return (i + (span ? (hz - pts[i].hz) / span : 0)) / last;
    };
    const toX = (hz) => P.l + pw * (EC_X_EVEN * ord(hz)
      + (1 - EC_X_EVEN) * (Math.log(hz) - x0) / (x1 - x0));

    // Y always fits everything drawn, live point included.
    let lo = Infinity, hi = -Infinity;
    for(const v of [...cur, ...(this._ghost ? dev : []), liveY]) {
      if(v == null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if(lo > hi) { lo = 0; hi = 1; }
    const pad = Math.max((hi - lo) * 0.1, 0.5);
    const yMin = Math.max(0, lo - pad), yMax = hi + pad;
    const toY = (v) => H - P.b - (v - yMin) / (yMax - yMin) * ph;
    const fromY = (py) => yMin + (H - P.b - py) / ph * (yMax - yMin);
    this._geo = { pts, cur, toX, toY, fromY };

    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    ctx.font = "9px sans-serif";
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.text;
    const gp = Math.pow(10, Math.floor(Math.log10((yMax - yMin) / 5)));
    const gn = (yMax - yMin) / 5 / gp;
    const gy = (gn < 1.5 ? 1 : gn < 3.5 ? 2 : gn < 7.5 ? 5 : 10) * gp;
    const dec = gy >= 1 ? 0 : gy >= 0.1 ? 1 : 2;
    ctx.textAlign = "right";
    for(let v = Math.ceil(yMin / gy) * gy; v <= yMax + gy / 1e6; v += gy) {
      ctx.beginPath(); ctx.moveTo(P.l, toY(v)); ctx.lineTo(W - P.r, toY(v)); ctx.stroke();
      ctx.fillText(v.toFixed(dec), P.l - 5, toY(v) + 3);
    }
    // Vertical grid on the anchors themselves - they are the axis that matters.
    ctx.textAlign = "center";
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.moveTo(toX(p.hz), P.t); ctx.lineTo(toX(p.hz), H - P.b); ctx.stroke();
      if(i % 2 === 0) ctx.fillText(String(p.hz), toX(p.hz), H - 5);
    });

    // One polyline, twice: the device underneath and the editable one on top.
    // Identical curves hide one another, so this costs nothing until an edit is
    // actually standing.
    const line = (vals, colour, width, dash) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      pts.forEach((p, i) => {
        if(vals[i] == null) { started = false; return; }
        started ? ctx.lineTo(toX(p.hz), toY(vals[i])) : ctx.moveTo(toX(p.hz), toY(vals[i]));
        started = true;
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if(this._ghost && dev.some((v, i) => v != null && !Reg.same(v, cur[i]))) {
      line(dev, C.ghost, 1, [4, 3]);
    }
    line(cur, C.edit, 2, []);

    // The working point: where the drive sits on this table right now.
    if(liveX != null && liveX >= pts[0].hz && liveX <= pts.at(-1).hz) {
      ctx.strokeStyle = C.live;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(toX(liveX), P.t); ctx.lineTo(toX(liveX), H - P.b); ctx.stroke();
      ctx.setLineDash([]);
      if(liveY != null) {
        ctx.fillStyle = C.live;
        ctx.beginPath(); ctx.arc(toX(liveX), toY(liveY), 4.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    pts.forEach((p, i) => {
      if(cur[i] == null) return;
      ctx.fillStyle = i === this._drag ? C.edit : C.dot;
      ctx.strokeStyle = C.edit;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(toX(p.hz), toY(cur[i]), i === this._drag ? 6 : 4, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });
  },

  //------------------------------------------------------------------------------------------ View

  View() {
    const busy = this._busy;
    const editable = S.connected && !this.pts().some(p => S.values[p.name] == null);
    // Undo holds values read from ONE drive. Reconnecting elsewhere would let
    // the arrow write device A's curve into device B, so the history ends with
    // the connection it came from.
    const bound = S.port + "/" + S.addr;
    if(this._bound !== bound) {
      this._bound = bound;
      this._hist = [];
      this._redo = [];
      this._preview = null;
      this._drag = -1;
    }

    return (
      <div class="ec">
        <div class="wg-row ec-tabs">
          {EC_TABLES.map(t =>
            <button class={cls("ec-tab", t === this._tab && "on")}
              onClick={() => EctraTables.setTab(t)}>{t}</button>)}
          <span class="wg-gap" />
          <button class="ec-tab" disabled={!this._hist.length || busy}
            onClick={() => EctraTables._step(EctraTables._hist, EctraTables._redo)}
            title="Cofnij ostatni zapis">↶</button>
          <button class="ec-tab" disabled={!this._redo.length || busy}
            onClick={() => EctraTables._step(EctraTables._redo, EctraTables._hist)}
            title="Ponów">↷</button>
          <button class="ec-tab" disabled={!editable || busy}
            onClick={() => EctraTables.smooth()}
            title={"Punkty skrajne zostają; każdy wewnętrzny w połowie drogi do "
              + "cięciwy sąsiadów - bez nowych ekstremów"}>Wygładź</button>
          <button class={cls("ec-tab", this._ghost && "on")}
            onClick={() => EctraTables.toggleGhost()}
            title="Pokaż pod spodem krzywą, która stoi na urządzeniu">urządzenie</button>
          <span class="ec-hover" ref={el => EctraTables._hoverEl = el} />
        </div>
        <div class="ec-curve">
          <div class="ec-slot" ref={el => EctraTables._slot(el)} />
          <div class="ec-foot">
            <span><em class="lg-edit" /> ustawiane</span>
            {this._ghost && <span><em class="lg-ghost" /> na urządzeniu</span>}
            {EC_LIVE[this._tab] && <span><em class="lg-live" /> punkt pracy</span>}
            <span class="wg-gap" />
            <span>{S.serial?.autosend
              ? "ciągnij kropkę; zapis po puszczeniu"
              : "ciągnij kropkę; zmiana czeka na Send"}</span>
          </div>
        </div>
      </div>
    );
  },
};

// Always on one table: there is no reading worth showing when none is picked,
// so picking none is not a state.
try {
  const saved = localStorage.getItem(EC_TAB_KEY);
  if(EC_TABLES.includes(saved)) EctraTables._tab = saved;
} catch(e) { /* the first table stands */ }

Widgets.register(EctraTables);
