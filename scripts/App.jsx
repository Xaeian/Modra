// scripts/App.jsx

// Root component. Toolbar (+ optional Serial row), optional chart bar, grid,
// footer. The whole tree is rebuilt on every render() - no reactive layer.

const App = () => {
  const regs = Reg.filter(Reg.visibility(S.regs), S.query);
  return (
  <div class="rb-panel">
    <div class="rb-header">
      <Toolbar />
      {S.serialOpen && <Serial />}
    </div>
    {S.showChart && <Monitor.Bar />}
    <div class="rb-grid">
      {Reg.columns(regs, gridColumnCount(regs.length)).map(col =>
        <div class="rb-col">{Reg.blocks(col).map(b => <Grid.Block regs={b} />)}</div>
      )}
    </div>
    <footer class="rb-footer">
      <span>Modra © {{ver}}</span>
      <span>Design by <a href="https://github.com/Xaeian" target="_blank">Xaeian</a></span>
      <span>{{foot}} with <a href="https://tonkajsx.com" target="_blank">TonkaJSX</a></span>
    </footer>
  </div>
  );
};
