const App = () => (
  <div class="rb-panel">
    <div class="rb-header">
      <Toolbar />
      {S.serialOpen && <Serial />}
    </div>
    <Monitor.Bar />
    <div class="rb-grid">
      {Reg.blocks(Reg.filter(S.regs, S.query)).map(b =>
        <Grid.Block regs={b} />
      )}
    </div>
  </div>
);