# Move

## What it does
Move translates a whole object — not any of its topology, unlike every
other tool here. There's no separate "select an object" mode in this
app, so Move reuses whatever face/edge/vertex is currently selected
purely to identify which object to move.

## How to use it
1. Select any face, edge, or vertex on an object.
2. Press **G** to begin.
3. Move the mouse — the object follows your cursor freely within the
   camera's current view plane, the same free 2-axis drag Extrude's
   vertex mode uses.
4. Optionally press **X**, **Y**, or **Z** to restrict the move to one
   world axis (press the same key again to release it). Once an axis is
   locked, that axis's offset can also be typed directly (e.g. `3` or
   `-1.5`) — typing any digit switches from mouse control to keyboard
   entry, Backspace edits it. The free (unconstrained) drag has no
   single number that describes it, so numeric entry only becomes
   available after locking an axis.
5. **Left click** or **Enter** to confirm, **right click** or **Esc** to
   cancel and snap back to the exact original position.

## What is visible
- The object (and everything selected on it) moves as a rigid whole —
  its shape never changes, only its position.
- The Tweakpane **Operations → G Move** row shows a hint by default and
  an explanation if move couldn't start (nothing selected).

## How it works technically
`src/operations/move.ts` is the simplest of these modules by far: unlike
Extrude/Scale/Bevel/Loop Cut, it never touches the `HalfEdgeMesh` at
all. `beginMove` just clones the `THREE.Mesh`'s own `.position`;
`updateMoveOffset` recomputes `basePosition + offset` from that recorded
original on every call (same non-compounding pattern Scale uses for its
own vertex positions), and `cancelMove` restores the original position
exactly.

Because nothing about the mesh's topology or vertex data changes, the
selection highlight — already parented under the `THREE.Mesh` (see
`SelectionManager`) — moves along automatically via the scene graph.
`MoveTool` never calls `refreshPrimitive()`, and never clears the
current selection either: unlike every topology-mutating tool, a move
never invalidates what was selected, so there's nothing to protect
against by clearing it.

**Dragging**: free-drag builds an offset from mouse movement projected
onto the active camera's right/up axes in world space (identical
mechanism to `ExtrudeTool`'s vertex-mode offset). Axis-constrained drag
instead projects a unit vector along the locked world axis into screen
space once (`computeAxisScreenDirection`), and maps further mouse
movement onto that single screen-space direction — mirroring how face
extrude derives its own fixed push direction. Switching which axis is
locked snaps the other two offset components back to 0 and resets
whatever had been typed into `NumericEntry`, matching Blender's own
G-then-X behavior (the other axes don't keep whatever the free drag had
left them at).

## Files involved
- `src/operations/move.ts` — position-only begin/update/commit/cancel
- `src/operations/MoveTool.ts` — modal interaction: G to start, X/Y/Z
  axis constraint, numeric offset entry once an axis is locked,
  free/constrained mouse drag, Enter/click to confirm, Esc/right-click
  to cancel
- `src/operations/NumericEntry.ts` — the shared keyboard numeric-entry
  mechanism (see its own doc comment; also used by Bevel, Scale, and
  Extrude)
- `src/operations/InteractionLock.ts` — prevents move from starting
  while another modal tool is mid-operation
- `src/ui/gui.ts` — the Operations panel's Move status row

## Known limitations
- No dedicated "select an object" mode — you always move through
  whatever face/edge/vertex selection already exists on it.
- Numeric entry only covers the axis-constrained offset, not the free
  2-axis drag — a deliberate scope decision (see "How to use it"
  above), not an oversight.
- Single object only — no multi-object move.
