// scripts/Misc.jsx

const Misc = {

  // Per-register tweaker drawer (⚙ on a numeric row). `cur` falls back to `min`
  // when the cache is empty so the thumb isn't parked at 0.
  Panel: ({ reg, value }) => {
    const step = Reg.step(reg);
    const mn = Reg.min(reg);
    const mx = Reg.max(reg);
    const cur = typeof value === "number" ? value : mn;
    // Step magnitude on +/- only for fractional steps; bare +/- reads cleaner.
    const stepLabel = step < 1 ? step : "";
    // Non-passive wheel listener so preventDefault can stop page scroll.
    const wheelHandler = (e) => {
      if(e.ctrlKey) return;  // let Ctrl+wheel fall through to page zoom
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const nv = Reg.snap(cur + dir * step, step);
      if(nv >= mn && nv <= mx) edit(reg, nv);
    };
    const attachWheel = (el) => {
      el.addEventListener("wheel", wheelHandler, { passive: false });
    };
    return (
      <div class="rb-util" ref={attachWheel}>
        <button class="rb-step-btn" onClick={() => {
          const nv = Reg.snap(cur - step, step);
          if(nv >= mn) edit(reg, nv);
        }}>-{stepLabel}</button>
        <input class="rb-slider" type="range"
          min={mn} max={mx} step={step} value={cur}
          onChange={(e) => edit(reg, Reg.snap(parseFloat(e.target.value), step))} />
        <button class="rb-step-btn" onClick={() => {
          const nv = Reg.snap(cur + step, step);
          if(nv <= mx) edit(reg, nv);
        }}>+{stepLabel}</button>
        <span class="rb-util-range">{mn}...{mx}</span>
      </div>
    );
  },
};
