// scripts/App.jsx

const App = () => (
  <div class="rb-panel">
    <div class="rb-header">
      <Toolbar />
      {S.serialOpen && <Serial />}
    </div>
    {S.showChart && <Monitor.Bar />}
    {S.showRegs && <div class="rb-grid">
      {Reg.blocks(Reg.filter(S.regs, S.query)).map(b =>
        <Grid.Block regs={b} />
      )}
    </div>}
    <footer class="rb-footer">
      <span>Modra © {{ver}}</span>
      <span>Design by <a href="https://github.com/Xaeian" target="_blank">Xaeian</a></span>
      <span>{{foot}} with <a href="https://tonkajsx.com" target="_blank">TonkaJSX</a></span>
    </footer>
  </div>
);