# Import / Export

## What it does
Export writes every primitive currently in the scene to a Wavefront OBJ
file and triggers a browser download. Each object becomes a separate
`o` group in the file, so re-importing elsewhere keeps them as distinct
meshes rather than one merged blob.

Import reads one or more `.obj` files and adds each object they contain
as a new primitive in the scene.

## How to use it
- Click **Export OBJ** to download the current scene. Nothing happens
  if the scene is empty — no file downloads, same as clicking Clear
  Selection with nothing selected.
- Click **Import OBJ** to pick one or more `.obj` files from disk. Every
  object found across all selected files is added to the scene in one
  action — a single Ctrl+Z undoes the whole batch, not one object at a
  time.

## What is visible
- Export: a `model.obj` file downloads through the browser's normal
  download flow.
- Import: the imported geometry appears in the scene at the position
  its own vertex data specifies (see below for why there's no separate
  placement step). The **Import / Export → Import** row reports what
  happened — how many objects were added, or why nothing was.

## How it works technically

### Export
`src/export/objExport.ts` splits into two pieces on purpose:
`buildObjString(meshes)` is pure — it takes plain `THREE.Mesh` objects
and returns text, touching neither the DOM nor `Viewport` — and
`downloadObj(meshes)` is the thin wrapper that calls it and triggers the
actual browser download. Keeping the string-building side pure means it
can be tested directly against real mesh geometry without needing a
live `Viewport` or WebGL context.

OBJ has no per-object transform, so every vertex position and normal is
baked into world space via `mesh.matrixWorld` — not just `mesh.position`,
in case a mesh ever gets a rotation or scale of its own later, matching
how `SelectionManager` already goes through `matrixWorld` rather than
assuming position-only. Normals are transformed with
`transformDirection()` specifically, which applies only the rotational
part of a matrix — translating a direction vector the way a position
gets translated would be wrong.

OBJ indices are 1-based and shared across the whole file, not reset per
object, so each object after the first needs its indices offset by the
running vertex count so far. Vertex normals reuse the exact same
per-triangle indices as positions (`f a//a b//b c//c`) rather than a
separate normal-index scheme, since `computeVertexNormals()` (called in
`HalfEdgeMesh.toBufferGeometry()`) always produces exactly one normal
per position in the same order — confirmed directly against real
exported geometry rather than assumed.

### Import
`src/export/objImport.ts`'s `parseObj()` is the pure counterpart to
`buildObjString()` — plain text in, `{ name, geometry }` objects out,
no DOM or Viewport dependency, so it's directly testable.

Faces with more than 3 vertices (quads, n-gons) are fan-triangulated
from their first vertex, since this app's `HalfEdgeMesh` is
triangle-only. This is exactly correct for convex polygons — quads from
a subdivided box or plane, the overwhelmingly common case — but isn't
guaranteed correct for a non-convex or non-planar n-gon; see Known
limitations.

OBJ vertex indices are global across the whole file and don't reset per
`o`/`g` group, but each parsed object needs its own self-contained,
locally-0-based vertex list to build a `BufferGeometry` from. `parseObj`
handles this by tracking, per group, exactly which global indices its
own faces reference, then building a local vertex list from only those
— the inverse of what `buildObjString`'s running index offset does on
the way out.

Because the file is untrusted external input (unlike a MeshBuilder
primitive or this app's own export), the parser doesn't assume it's
well-formed: a face line referencing an out-of-range vertex index, or
forming a degenerate triangle (a repeated vertex within one face), is
skipped rather than fed into `HalfEdgeMesh` — either would otherwise
produce broken topology (`validate()` failures like "twin shares the
same destination vertex" for a degenerate triangle) or a hard crash
from reading past the end of the vertex array. Skipped faces are
counted and reported in the status message rather than silently
dropped.

Imported objects are added via `HalfEdgeMesh.fromBufferGeometry()` —
the same merge-by-position variant used for importing a fresh Three.js
primitive, not the no-merge `fromBufferGeometryExact()` History uses —
since an arbitrary external file isn't guaranteed to reuse vertex
indices efficiently the way this app's own export or a Three.js
primitive does; merging by position is what correctly reconstructs
shared edges either way.

**Placement**: every imported object is added at `THREE.Vector3(0, 0,
0)`, not through Add Primitive's grid-spawn layout. `buildObjString`
already bakes each object's world position into its vertex coordinates
on the way out, so the coordinates in a `.obj` file (at least one this
app produced) already represent the intended final layout — applying
an additional grid-offset on import would scatter an already-arranged
multi-object scene instead of preserving it.

Verified with `parseObj` tests covering: plain triangle meshes, quad and
pentagon fan-triangulation (confirming the n-2 triangle count),
multiple `o` groups (confirming each gets correctly re-indexed local
data, not leftover global indices), negative/relative vertex indices,
an out-of-range index and a degenerate triangle (both correctly skipped
rather than crashing), comments/`vt`/`vn`/`mtllib`/`usemtl`/`s` lines
mixed in (confirming they're ignored without breaking anything), and a
full round-trip — export a real two-object scene from this app,
re-import that exact text, rebuild via `HalfEdgeMesh`, and confirm both
objects validate with matching vertex/triangle counts and correctly
preserved world-space positions.

## Files involved
- `src/export/objExport.ts` — `buildObjString()` (pure) and
  `downloadObj()` (the browser-download trigger)
- `src/export/objImport.ts` — `parseObj()` (pure) and
  `triggerObjImport()` (the file-picker trigger, scene mutation, and
  History wiring)
- `src/ui/gui.ts` — the Import / Export panel's buttons and the
  Import status row

## Known limitations
- OBJ only — no GLTF yet.
- No material/color export or import — every primitive is currently
  spawned white regardless, so there's nothing to preserve yet.
- Fan triangulation of n-gons is only guaranteed correct for convex,
  planar polygons; a concave or non-planar face from another tool could
  triangulate incorrectly.