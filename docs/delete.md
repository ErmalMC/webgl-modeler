# Delete

## What it does
Delete removes a selected face, edge, or vertex — along with whatever
triangles depend on it. Every half-edge in this mesh must belong to a
triangle, so there's no "delete a face but leave its edges behind" the
way Blender's Delete Faces does on an n-gon mesh; removing a triangle
always removes its 3 half-edges with it.

- **Face** selection removes the whole coplanar group (e.g. both
  triangles of a cube face).
- **Edge** selection removes the 1–2 raw triangles touching that edge —
  matching Blender's own "Delete Edges" (faces using the edge are
  deleted with it). If the edge is the internal diagonal of a coplanar
  group, this removes the whole visual face; if it's a boundary between
  two different groups, it removes one triangle from each, leaving an
  irregular hole — an accurate reflection of the mesh's actual
  triangulation, not a bug.
- **Vertex** selection removes every triangle touching that vertex,
  matching Blender's "Delete Vertices."

Any vertex left with no surviving half-edge afterward (fully surrounded
by what was just deleted) is removed too, since an isolated vertex fails
`validate()`.

## How to use it
1. Select a face, edge, or vertex in any selection mode.
2. Press **Delete** (or **Backspace** — some laptop keyboards have no
   dedicated Delete key).
3. **Left click** or **Enter** to confirm, **right click** or **Esc** to
   cancel and restore everything exactly.

Unlike Extrude/Scale, there's no drag phase — the removal happens
immediately, the same way Loop Cut and Bevel commit right away. The
confirm/cancel window still exists for muscle-memory consistency with
the other tools and as a safety net against an accidental press.

## What is visible
- The deleted geometry disappears immediately; any faces bordering it
  are left with an open boundary edge where the removed geometry used to
  connect.
- The Tweakpane **Operations → Del Delete** row shows a hint by default.

## How it works technically
`src/operations/delete.ts` exposes three entry points —
`beginDeleteFaces`, `beginDeleteEdge`, `beginDeleteVertex` — that each
compute the right set of triangles to remove for their selection mode,
then hand off to one shared `removeFaces()` core (mirroring how
`extrude.ts` has multiple `begin*` functions sharing one shape).

`removeFaces()` does three things, all recorded before mutation so
`cancelDelete()` can restore everything exactly:

1. For every removed half-edge whose twin survives (belongs to a
   triangle outside the removed set), that twin's `.twin` is nulled —
   it's now a boundary edge. The original edge it pointed to is recorded
   so cancel can put the link back.
2. Every vertex touched by a removed triangle is checked for a
   surviving half-edge. If it still has one, its `.halfEdge` reference
   is repointed away from any removed edge (same pattern as
   bevel.ts/loopCut.ts). If it has none left at all, the vertex itself
   is removed.
3. The removed faces, half-edges, and orphaned vertices are filtered out
   of the mesh's arrays; `cancelDelete()` concatenates them straight
   back.

Verified against a real `HalfEdgeMesh` built from both a Box (face
delete, internal-diagonal edge delete, cross-group boundary edge delete,
vertex delete, and compounding deletes without cancel) and a Cylinder
(deleting the triangle-fan cap's shared hub vertex, and deleting the
whole cap group) — `validate()` passes at every step and cancel restores
exact original vertex/face/half-edge counts in all cases.

## Files involved
- `src/operations/delete.ts` — the three `begin*` entry points and the
  shared `removeFaces()` core: twin-nulling, orphan-vertex detection,
  begin/commit/cancel
- `src/operations/DeleteTool.ts` — modal interaction: Delete/Backspace
  to remove immediately, Enter/click to confirm, Esc/right-click to
  cancel
- `src/operations/InteractionLock.ts` — prevents delete from starting
  while another modal tool is mid-operation
- `src/ui/gui.ts` — the Operations panel's Delete status row

## Known limitations
- No multi-selection — deletes one face/edge/vertex selection at a
  time.
- Deleting an edge that's a boundary between two different coplanar
  groups leaves an intentionally irregular hole (see above) rather than
  trying to guess a "nicer" merged result.
