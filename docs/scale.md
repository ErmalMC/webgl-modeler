# Scale / Stretch

## What it does
Scale resizes a selected face or edge around its own centroid, larger or
smaller, either uniformly or constrained to a single world axis. Unlike
Extrude, Scale never creates or removes any geometry — it only moves the
vertices that are already there, so a scaled face's shared corners
naturally drag the neighboring faces along with them, the same way
Blender's does.

## How to use it
1. Select a face (key **1**) or an edge (key **2**). Vertex selections
   can't be scaled — a single point has no size to change, so `S` reports
   why instead of doing nothing silently.
2. Press **S** to begin.
3. Move the mouse **away** from the selection's on-screen center to grow
   it, or **toward** it to shrink it — direction doesn't matter, only
   distance from that center point. Or type a number directly for an
   exact factor (e.g. `2` to double the size, `0.5` to halve it) —
   typing any digit switches from mouse control to keyboard entry,
   works with or without an axis constraint active.
4. Optionally press **X**, **Y**, or **Z** to restrict the resize to one
   axis (press the same key again to release the constraint and go back
   to all axes).
5. **Left click** or **Enter** to confirm, **right click** or **Esc** to
   cancel and restore the original size exactly.

## What is visible
- The selected face or edge grows/shrinks live as the mouse moves; any
  neighboring geometry sharing a vertex with the selection visibly
  stretches along with it.
- The Tweakpane **Operations → S Scale** row shows a hint by default and
  an explanation if scale couldn't start (nothing selected, or a vertex
  was selected instead of a face/edge).

## How it works technically
`src/operations/scale.ts` is the simplest of the four operations,
topologically: `beginScale` takes a flat list of vertices (a face
selection's full boundary+interior set, or an edge selection's 2
endpoints), computes their centroid once, and records each vertex's
pre-scale position. `updateScale` recomputes every vertex's position from
that recorded original on every call — `center + (original - center) *
factor` — rather than compounding onto whatever the current position
already is, so repeated drag updates can't accumulate rounding error or
drift. An `axis` argument restricts this to a single component of that
offset vector (only `x`, only `y`, or only `z`), leaving the other two
exactly as they were.

Because `beginScale` only needs "some vertices" rather than anything
face- or edge-specific, the same function drives both a face scale and an
edge scale — `ScaleTool` is the only place that branches on selection
mode, purely to decide *which* vertices to pass in.

`commitScale` calls `invalidateSelectableFaces()` even though it doesn't
touch topology: a non-uniform axis-constrained scale can pull a face's
two triangles out of coplanar alignment with each other, which would
silently break `getSelectableFaces()`'s coplanar grouping for the next
click if the cache weren't cleared.

**Dragging**: `ScaleTool` tracks the mouse's on-screen distance from the
selection's projected pivot point at the moment `S` was pressed, and
divides the current distance by that starting distance to get the scale
factor — moving away grows it past 1, moving closer shrinks it toward 0.
This mirrors Blender's own scale-cursor behavior, and is a deliberately
different control feel from Extrude's fixed-direction drag: a resize
doesn't have a direction the way a push-out does, only a size.

## Files involved
- `src/operations/scale.ts` — scale topology math: begin/update/commit/
  cancel, axis constraint
- `src/operations/ScaleTool.ts` — modal interaction: keyboard (S / X / Y /
  Z / Enter / Esc), pivot-distance-ratio mouse tracking, numeric factor
  entry, status messages
- `src/operations/NumericEntry.ts` — the shared keyboard numeric-entry
  mechanism (see its own doc comment; also used by Bevel, Extrude, and
  Move)
- `src/operations/InteractionLock.ts` — prevents scale from starting
  while another modal tool is mid-operation
- `src/ui/gui.ts` — the Operations panel's Scale status row

## Known limitations
- Single face or single edge selection only — no multi-selection scale.
- No visible pivot-point marker in the viewport; the center it's scaling
  around is implicit (the selection's own centroid) rather than shown.