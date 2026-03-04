// scripts/Misc.jsx



// TODO: Monitor.Bar will become chart/graph container
// TODO: monitored registers should be polled at `interval` and values pushed to time-series buffer
// TODO: render real-time line chart (per-variable trace, shared time axis)

const Monitor = {
  Bar: () => {
    if(!S.monitor.size) return null;
    return (
      <div class="rb-monitor-bar">
        <span class="rb-monitor-label">📊 Monitor ({S.monitor.size}):</span>
        {[...S.monitor].map(name => {
          const reg = S.regs.find(r => r.name === name);
          return (
            <span class="rb-monitor-tag" onClick={() => reg && monitor(reg)} title="Click to remove">
              {name} ✕
            </span>
          );
        })}
      </div>
    );
  },
};