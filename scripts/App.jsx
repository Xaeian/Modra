// scripts/App.jsx

// Root component. The whole tree is rebuilt on every render() - no reactive layer.

// `View()` runs inside the normal render pass and must tolerate a rebuild
// twice a second - see scripts/widgets/readme.md.
// The header is sticky, so anything else that sticks has to start below it -
// and it is not one height: opening the serial panel makes it taller. Published
// as a variable rather than guessed at in CSS, because a guess is wrong in one
// of the two states and silently wrong in the other.
//
// Measured after the frame lands. A `ref` fires while the node is still out of
// the document, where every rect reads zero.
function headHeight(el) {
  if(!el) return;
  requestAnimationFrame(() => {
    const px = el.offsetHeight + "px";
    const root = document.documentElement;
    if(el.offsetHeight && root.style.getPropertyValue("--rb-header-h") !== px) {
      root.style.setProperty("--rb-header-h", px);
    }
  });
}

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
      <div class="rb-header" ref={headHeight}>
        <Toolbar />
        {S.serialOpen && <Serial />}
      </div>
      {S.showChart && <Monitor.Bar />}
      {Widgets.over().map(w => <WidgetPanel widget={w} />)}
      <div class="rb-body">
        {Widgets.beside().length > 0 &&
          <aside class="rb-side">
            {Widgets.beside().map(w => <WidgetPanel widget={w} />)}
          </aside>}
        <div class="rb-grid">
          {Reg.columns(regs, gridColumnCount(regs.length)).map(col =>
            <div class="rb-col">{Reg.blocks(col).map(b => <Grid.Block regs={b} />)}</div>
          )}
        </div>
      </div>
      <footer class="rb-footer">
        <span>Modra © {{ver}}</span>
        <span>Design by <a href="https://github.com/Xaeian" target="_blank">Xaeian</a></span>
        <span>{{foot}} with <a href="https://tonkajsx.com" target="_blank">TonkaJSX</a></span>
      </footer>
    </div>
  );
};
