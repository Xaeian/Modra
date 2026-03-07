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
  </div>
);