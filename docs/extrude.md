# Extrude

## What it does
Extrude pushes a selected face outward (or inward) along its normal,
generating new connecting geometry so the mesh grows instead of just
moving. It also works on a single selected vertex, where it produces a
thin "whisker" spike rather than a new face — matching Blender's own
distinction between extruding a face (which sweeps out a wall) and
extruding a lone vertex (which doesn't drag any existing surface along
with it).

## How to use it
**Face extrude:**
1. Switch to face-select mode (key **1**) and click a face.
2. Press **E** to begin.
3. Move the mouse — the face slides in or out along its own normal only;
   there's no other direction to push a flat face in.
4. **Left click** or **Enter** to confirm, **right click** or **Esc** to
   cancel and put the mesh back exactly as it was.

**Vertex extrude:**
1. Switch to vertex-select mode (key **3**) and click a vertex.
2. Press **E** to begin.
3. Move the mouse anywhere — unlike a face, a vertex has no single
   "correct" direction, so the tip follows your cursor freely within the
   camera's current view plane (drag right, it goes right; drag up, it
   goes up; the surrounding mesh stays completely still).
4. Confirm/cancel the same way as face extrude.
5. Press **E** again on that same tip to chain another segment onto it,
   extending the whisker further — this is a distinct code path
   (`beginTipExtrude`) from the first extrude on that vertex
   (`beginVertexExtrude`), tried automatically in that order.

Extrude only works on a **single** selected face or vertex — no
multi-selection yet.

## What is visible
- The selected face (orange highlight) grows a new "cap" at the dragged
  position, connected to the original boundary by new wall geometry.
- A vertex extrude shows a thin spike reaching out from the selected
  point; the point it came from stays fixed and keeps the rest of the
  surface undisturbed.
- The Tweakpane **Operations → E Extrude** row shows a hint by default and
  swaps to an explanation for a few seconds if extrude couldn't start
  (e.g. nothing selected, or trying to extrude an edge selection, which
  isn't implemented).

## How it works technically
Two genuinely different operations live behind one key, both in
`src/operations/extrude.ts`:

- **`beginFaceExtrude`** clones every vertex on the face's boundary loop,
  re-points the original face to the clones (so it becomes the moving
  "cap"), and builds a ring of new wall triangles connecting the cap back
  to where the original boundary used to be. A face group that also has
  an *interior* vertex not on that boundary loop — a Cylinder cap,
  triangulated as a fan from a center hub — gets that hub vertex dragged
  in place instead of cloned, since nothing outside the group ever
  references it; cloning it anyway would just leave an orphaned, unused
  copy behind.
- **`beginVertexExtrude`** / **`beginTipExtrude`** build a "whisker": two
  new triangles sharing the new spike edge, using a synthetic third
  corner (not a reused mesh vertex) so chained extrudes on the same tip
  can never collide with existing geometry. That third corner needs a
  real, small, fixed offset — not a point sitting exactly on top of one
  of the whisker's other two corners — or the triangles are permanently
  zero-area and the whisker never actually renders no matter how far the
  tip is dragged.

Every one of these functions returns a handle carrying enough
information (each moved vertex's pre-drag position, every original
edge-to-vertex assignment, every boundary edge's original neighbor link)
for `cancelExtrude` to undo the operation exactly — not by inferring what
changed, but by restoring the recorded originals directly. That twin-link
restoration in particular was a real bug during development: it's easy to
delete the new wall/whisker geometry on cancel while forgetting that an
untouched neighboring face was pointed at it — `validate()` doesn't catch
this, since the corrupted pair is still consistent with itself; it took
an explicit scan for half-edges whose `.twin` no longer points at
anything in the live mesh to find it.

**Dragging**: face extrude uses `updateExtrudeDistance`, a single scalar
distance along the face's fixed normal. Vertex/tip extrude uses
`updateExtrudeOffset`, a free 3D offset — `ExtrudeTool` builds this from
mouse movement projected onto the active camera's right/up axes in world
space, so the tip tracks the cursor regardless of camera angle.

## Files involved
- `src/operations/extrude.ts` — all extrude topology math: begin/update/
  commit/cancel for both face and vertex/tip extrude
- `src/operations/ExtrudeTool.ts` — modal interaction: keyboard (E /
  Enter / Esc), mouse drag, screen-space-to-world-space projection,
  status messages
- `src/operations/InteractionLock.ts` — prevents extrude from starting
  while another modal tool (Scale, Loop Cut, Bevel) is mid-operation
- `src/mesh/Halfedgemesh.ts` — `getBoundaryLoop` (face extrude's wall
  needs the face's outer edge loop) and `getVertexRing` (vertex extrude
  needs the full ring of triangles around the vertex; throws for a
  boundary vertex, which is why extrude can fail on some vertices)
- `src/ui/gui.ts` — the Operations panel's Extrude status row

## Known limitations
- Single face or single vertex only — no multi-selection extrude.
- Edge-mode selection can't be extruded (`ExtrudeTool` explicitly reports
  this rather than attempting it).
- Vertex extrude requires an *interior* vertex with a fully closed ring —
  a boundary vertex (e.g. a Plane's corners) has nowhere for the ring walk
  to close and throws a clear error instead of guessing.
- No numeric input for exact distance/offset — mouse drag only.
