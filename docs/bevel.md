# Bevel

## What it does
Bevel softens a sharp edge by replacing it with two parallel edges and a
flat face between them, chamfering what used to be a hard corner. It's
scoped to a single interior edge (one with a triangle on both sides) and
a single segment — a flat chamfer, not Blender's variable-segment rounded
profile.

## How to use it
1. Switch to edge-select mode (key **2**) and click an edge.
2. Press **Ctrl+B** (or **Cmd+B** on Mac) to start. Like Loop Cut, there's
   no drag-from-zero phase — the bevel is inserted immediately at a
   default width, since a zero-width bevel isn't a smaller bevel, it's
   degenerate geometry.
3. Move the mouse to grow or shrink the bevel's width live.
4. **Left click** or **Enter** to confirm, **right click** or **Esc** to
   cancel and restore the original sharp edge exactly.

The selected edge must have a face on both sides — an edge on the outer
boundary of an open mesh (like a Plane's edges) can't be beveled, and
`Ctrl+B` reports why instead of attempting it.

## What is visible
- The sharp edge is replaced by a small flat strip face, with the two
  original faces trimmed back to meet it — visually a chamfered corner
  instead of a hard crease.
- The Tweakpane **Operations → ^B Bevel** row shows a hint by default and
  an explanation if the bevel couldn't start (no edge selected, or the
  edge is on the mesh's boundary).

## How it works technically
Beveling edge A–B isn't just inserting a strip — the two triangles on
either side of it each lose a corner at *both* A and B, and whatever
untouched face used to sit across those corners still expects to meet the
original points. Left alone, that's a hole. `src/operations/bevel.ts`
closes it with a small 3-triangle fan at each endpoint: one triangle
preserving each side's untouched neighbor link, and a third bridging the
two and closing off that end of the strip. In total, one bevel replaces
2 original triangles with 10 new ones (2 trimmed originals, 2 forming the
strip, and 3+3 closing the two ends) and roughly 15 new twin
(adjacency) links — all derived by hand and checked against a running
mesh (`validate()`, an explicit scan for half-edges whose twin no longer
points at anything live, a boundary-edge count on meshes that should stay
fully closed, and outward-facing normals) before being trusted.

Two of the ten new triangles per endpoint are mathematically forced to be
perfectly flat (their third corner sits, by construction, exactly on the
line between the other two) — this is expected, not a bug: they exist
purely to satisfy the "every half-edge belongs to a triangle" structural
requirement and contribute no visible surface, confirmed directly rather
than assumed.

Bevels on edges that share a vertex, or even a second bevel on an edge
that used to be part of an already-beveled corner, were suspected during
planning to produce overlapping geometry — by analogy with Blender's own
multi-edge bevel needing to merge corner caps across a selected chain.
That turned out not to be true here: each `beginBevel` call is fully
self-contained, so a second bevel on an adjacent or already-beveled edge
just carves its own independent notch. Stress-tested with up to 4 chained
bevels around one shared vertex with no overlap or corruption found.

## Files involved
- `src/operations/bevel.ts` — corner-fan construction and twin wiring:
  begin/commit/cancel
- `src/operations/BevelTool.ts` — modal interaction: Ctrl+B to start,
  live width adjustment (re-running the whole operation from the
  original edge at the new width on every mouse move, rather than
  repositioning existing vertices directly, so the live-adjusted result
  always goes through the same verified code path as the initial cut),
  Enter/click to confirm, Esc/right-click to cancel
- `src/operations/InteractionLock.ts` — prevents bevel from starting
  while another modal tool is mid-operation
- `src/ui/gui.ts` — the Operations panel's Bevel status row

## Known limitations
- Boundary edges (no face on one side) aren't supported — the "2 faces
  meet here" derivation this is built on doesn't apply with only one
  face present.
- Only 1 segment (a single flat chamfer face), not a rounded,
  multi-segment profile.
- No numeric input for an exact width — mouse drag only, starting from a
  fixed default.
