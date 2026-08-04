# Widgets

A panel for one device family, expressing what the generic register grid cannot -
a lookup table, a tuning curve. Frontend only: no backend, no `view.json` state,
no persistent DOM.

## Adding one

`scripts/widgets/<id>.jsx` ending in `Widgets.register(<Obj>)`, styles in
`styles/widgets-<id>.css`, id listed in `app.ini`. Both files are bundled
automatically.

```js
{
  id: "ectra",                  // must match the app.ini entry
  title: "Ectra · V/f table",
  match(regs),                  // does this catalog carry what we need
  View(),                       // JSX for the panel body
}
```

Match on register names, never a device id - the catalog is the only source of
truth about a device here.

## Gates

A widget shows when **both** hold: listed in `app.ini`, and `match()` accepts the
catalog. Then 🧩 (key `w`) reveals the panels; with nothing matching, the button
is not rendered at all. `app.ini` gates activation, not compilation - an
unlisted widget still ships, inert.

## Rules

- Read `S`, never write it. Device values go through `writeNow(patch)`, UI state
  through `actions.js`. Never call `API.write` directly.
- `View()` is rebuilt about twice a second. Anything the render must not lose
  belongs on the widget object.
- `ref` fires on a detached node: good for `addEventListener` and `innerHTML`,
  useless for layout, focus or scrolling.
- The JSX runtime cannot make SVG nodes - inject SVG as markup via `ref`.
- A focused button loses focus on the next render; a text input loses its caret
  unless it carries `.wg-hold`. Prefer buttons and selects.
- Never `stopPropagation()` a click - the render driver flushes deferred renders
  on the document click listener.
- Preferences live in `localStorage`, keyed `modra.<id>.*`.

## Write cadence

A write reads back the registers it wrote, so `S.values` holds what the device
stored, never an echo of the request. A control loop should batch its registers
into one patch and await each write, so it paces itself to the link instead of
queueing behind it, and should compute each step from `S.values` so a clamped or
refused write is corrected rather than compounded.
