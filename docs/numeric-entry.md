# Numeric Entry

## What it does
Lets a modal drag (Bevel, Scale, Extrude, Move) take an exact typed
value instead of relying on the mouse — Blender's own convention:
pressing a digit while dragging locks the operation to keyboard input.

## How to use it
While any of these tools is mid-drag, type a number: digits append,
`-` toggles the sign, `.` adds a decimal point, Backspace edits it.
Enter confirms the operation at that value; Escape still cancels the
whole operation exactly as it always did (typing a number doesn't
change what Escape does). Clearing the typed value back to empty with
Backspace falls back to mouse control again.

Not every tool takes numeric entry the same way:
- **Bevel** (width) and **Scale** (factor) — always available.
- **Extrude** — only in face mode (a single scalar distance). Vertex
  mode is a free 2-axis drag with no single number to type, so it stays
  mouse-only.
- **Move** — only once an axis (X/Y/Z) is locked, for the same reason
  as Extrude's vertex mode: the free, unconstrained drag has no single
  scalar either.

## What is visible
The tool's own status row shows the value as it's typed (e.g. "Width:
1.5"), the same status mechanism each tool already uses for error
messages.

## How it works technically
`src/operations/NumericEntry.ts` is a small, tool-agnostic class: it
only tracks a text buffer and whether entry is active, and exposes
`handleKey(e)` (returns whether it consumed the keydown),
`value` (the parsed number, or `null` if the buffer is empty or
incomplete — e.g. just `"-"` or `"."`), and `reset()`. It's a
self-contained keyboard-input mechanism with no interaction-lock or
tool-specific knowledge at all — deliberately not a mixin or a
subclassing scheme, since composing it into a class is one line
(`private numericEntry = new NumericEntry();`) and giving it any deeper
integration than "call `handleKey`, read `value`, call `reset`" would
add coupling for no real benefit.

Each tool wires it in the same shape:
1. In `handleKeydown`, after the `!this.active` guard, give
   `numericEntry.handleKey(e)` first crack at the key; if it returns
   `true`, apply the typed value and return before reaching the tool's
   own Enter/Escape/axis-key handling. Digits, `-`, `.`, and Backspace
   never collide with any tool's own bindings (letters, Enter, Escape),
   so this ordering is safe without any special-casing.
2. In `handlePointerMove`, bail out early if `numericEntry.active` —
   once typing has started, mouse movement is ignored until the value
   is confirmed, cancelled, or backspaced away entirely.
3. Every tool factors its "recompute the live geometry/position from a
   scalar" logic into one shared private method (e.g. BevelTool's
   `applyWidth`, ScaleTool's `applyFactor`) that both mouse-drag and
   numeric entry call — numeric entry is just an alternate way of
   arriving at the same `updateScale`/`updateExtrudeDistance`/
   `updateMoveOffset` call mouse-dragging already makes, not a separate
   code path with its own risk of drifting out of sync.
4. `numericEntry.reset()` is called wherever a drag starts and wherever
   it finishes, so a leftover typed value from one operation can never
   bleed into the next.

A typed value respects the same safety clamps mouse-dragging already
enforces where one exists — Bevel's `MIN_WIDTH` and Scale's
`MIN_FACTOR` — since a typed 0 or negative value would otherwise
collapse or invert geometry mouse-dragging is already careful to
prevent. Extrude's distance and Move's offset have no such clamp,
since negative/zero values are already explicitly valid for both (see
their own docs).

Verified in isolation with 10 cases: digit accumulation, decimal point
(including a second one being ignored rather than resetting anything),
sign toggling in both directions, minus pressed before any digit,
backspace-to-empty deactivating, backspace being a no-op before entry
starts, Enter/Escape/letter keys never being consumed, `reset()`
returning to a clean state, numpad digit codes working identically to
top-row ones, and a lone `"-"` or `"."` never parsing to a number.

## Files involved
- `src/operations/NumericEntry.ts` — the class itself
- `src/operations/BevelTool.ts`, `ScaleTool.ts`, `ExtrudeTool.ts`,
  `MoveTool.ts` — each tool's own wiring, per the pattern above

## Known limitations
- No unit suffix parsing (Blender lets you type `2m` or similar in some
  contexts) — plain numbers only.
- No live numeric preview independent of a tool's own status row — the
  typed value is only visible via the same 4-second status message
  every other tool status already uses, not a persistent on-screen
  readout.
