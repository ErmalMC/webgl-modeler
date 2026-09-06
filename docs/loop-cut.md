# Loop Cut

## What it does
Loop Cut inserts a new ring of edges around a strip of quad faces,
slicing through every quad it crosses at the midpoint. Selecting one edge
of a box and cutting produces a full ring around all four side faces in
one action, the same way Blender's loop cut works on a quad-based mesh —
even though the mesh underneath is entirely triangles (see "How it works
technically" for how that gap is bridged).

## How to use it
1. Switch to edge-select mode (key **2**) and click an edge.
2. Press **Ctrl+R** (or **Cmd+R** on Mac) to cut. Unlike Extrude and
   Scale, there's no drag phase — the cut is inserted immediately at the
   midpoint of every edge it crosses, since a loop cut has no natural
   "zero" state to grow out of.
3. **Left click** or **Enter** to confirm, **right click** or **Esc** to
   undo the cut completely and restore the original faces.

The edge you click doesn't need to be the "start" of anything in
particular — Loop Cut discovers the full ring in both directions from
whichever edge you select.

## What is visible
- The selected edge's ring of quads is each split into 4 triangles by the
  new cut, visible as a new loop of edges running around (or across) the
  mesh at each crossed edge's midpoint.
- On a fully closed shape (like a box), the ring closes back on itself.
  On a shape with real open edges (like a Plane), the ring stops at the
  mesh's boundary instead.
- The Tweakpane **Operations → ^R Loop Cut** row shows a hint by default
  and an explanation if the cut couldn't be made (no edge selected, the
  edge is a face's internal diagonal, or the ring runs into a non-quad
  face like a Cylinder cap).

## How it works technically
This mesh is triangulated everywhere — there's no native quad type to
walk a "ring" over the way Blender does internally. `src/operations/
loopCut.ts` instead treats a "quad" as any `SelectableFace` group (the
same coplanar-triangle grouping face-select already uses) made of exactly
2 triangles with a clean 4-edge boundary loop, which is what every quad
face on this project's primitives already looks like.

**Discovery** (`discoverRing`) walks outward from the selected edge in
both directions before mutating anything: each step crosses from a
quad's *entry* edge to its *exit* edge (the one directly opposite it in
the 4-edge boundary), then continues into whatever quad is on the other
side of that exit edge. It stops when the ring closes back on the
starting quad (a closed ring), or when it reaches a genuine mesh boundary
with nothing on the other side (an open ring). It throws — cleanly,
before touching any topology — if the walk would need to cross into a
non-quad face, or if the originally-selected edge turns out to be a
face's internal diagonal rather than one of its 4 outer edges.

**Cutting** (`cutQuad`, called once per quad in the validated ring) splits
each quad into 4 new triangles around a shared pair of midpoint vertices
— reusing the midpoint two consecutive quads in the ring already share,
rather than creating a duplicate at every crossing. Each half of a split
quad is itself 2 triangles sharing their own internal diagonal, distinct
from the new *center* cut edge shared between the two halves — a real bug
during development came from wiring only the center edge's twin and
forgetting those two per-quad diagonals, which left a mesh that still
passed `validate()` but had 16 unmatched boundary edges after cutting a
ring around what should have been a fully closed box.

## Files involved
- `src/operations/loopCut.ts` — ring discovery and quad re-triangulation:
  begin/commit/cancel
- `src/operations/LoopCutTool.ts` — modal interaction: Ctrl+R to cut
  immediately, Enter/click to confirm, Esc/right-click to undo
- `src/operations/InteractionLock.ts` — prevents loop cut from starting
  while another modal tool is mid-operation
- `src/mesh/Halfedgemesh.ts` — `getSelectableFaces` (the coplanar grouping
  a "quad" is defined against) and `getBoundaryLoop` (used per-quad to
  find each one's 4 outer edges)
- `src/ui/gui.ts` — the Operations panel's Loop Cut status row

## Known limitations
- Only cuts through quad-shaped `SelectableFace` groups — a triangle fan
  (a Cylinder cap) or a lone triangle can't be part of a ring; the ring
  walk throws a clear error rather than guessing what to do.
- Always cuts at the exact midpoint of every crossed edge — no
  off-center slide, and no support for inserting more than one parallel
  cut at once (Blender's scroll-wheel "number of cuts").
- No live preview while dragging — the ring is committed the instant
  Ctrl+R is pressed, and only the confirm/cancel step is interactive.
