// scripts/App.jsx

// Root component. The whole tree is rebuilt on every render() - no reactive layer.

// `View()` runs inside the normal render pass and must tolerate a rebuild
// twice a second - see scripts/widgets/readme.md.
const WidgetPanel = ({ widget }) => (
  <section class="wg">
    <div class="wg-head">{widget.title || widget.id}</div>
    {widget.View()}
  </section>
);

// Startup map question. With no map there is nothing to continue with.
const MapPicker = () => {
  const has = S.regs.length > 0;
  return (
    <div class="rb-nomap">
      <h1>Modra</h1>
      {has
        ? <p><b>{S.regs.length}</b> registers loaded from <code>regs.csv</code>.</p>
        : <p>No register map found. Pick a <code>regs.csv</code> to set up this device.</p>}
      <div class="rb-nomap-row">
        <button class="rb-tbtn" onClick={pickMap}>
          📂 {has ? "Load another map" : "Choose regs.csv"}
        </button>
        {has && <button class="rb-tbtn on" onClick={() => boot(true)}>Continue ▶</button>}
      </div>
      {has &&
        <label class="rb-nomap-skip">
          <input type="checkbox" checked={!S.askMap} onChange={toggleAskMap} />
          Don't ask again
        </label>}
    </div>
  );
};

const App = () => {
  if(S.mapPrompt) return <MapPicker />;
  const regs = Reg.filter(Reg.visibility(S.regs), S.query);
  return (
    <div class="rb-panel">
      <div class="rb-header">
        <Toolbar />
        {S.serialOpen && <Serial />}
      </div>
      {S.showChart && <Monitor.Bar />}
      {S.showWidgets && Widgets.active().map(w => <WidgetPanel widget={w} />)}
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
