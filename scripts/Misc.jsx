// scripts/Misc.jsx

const Misc = {
  Panel: ({ reg, value }) => {
    const step = Reg.step(reg);
    const mn = Reg.getMin(reg);
    const mx = Reg.getMax(reg);
    const cur = (value != null && typeof value === 'number') ? value : mn;
    const stepLabel = step < 1 ? step : '';
    const wheelHandler = (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const nv = Reg.snap(cur + dir * step, step);
      if(nv >= mn && nv <= mx) edit(reg, nv);
    };
    const attachWheel = (el) => {
      el.addEventListener('wheel', wheelHandler, {passive: false});
    };
    return (
      <div class="rb-util" ref={attachWheel}>
        <button class="rb-step-btn" onClick={() => {
          const nv = Reg.snap(cur - step, step);
          if(nv >= mn) edit(reg, nv);
        }}>−{stepLabel}</button>
        <input class="rb-slider" type="range"
          min={mn} max={mx} step={step} value={cur}
          onChange={(e) => edit(reg, Reg.snap(parseFloat(e.target.value), step))} />
        <button class="rb-step-btn" onClick={() => {
          const nv = Reg.snap(cur + step, step);
          if(nv <= mx) edit(reg, nv);
        }}>+{stepLabel}</button>
        <span class="rb-util-range">{mn}…{mx}</span>
      </div>
    );
  },
};