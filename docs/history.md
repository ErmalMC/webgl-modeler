# Undo / Redo

## What it does
History gives every persistent scene change — Move, Delete, Extrude,
Scale, Loop Cut, Bevel, Add Primitive, and Clear Scene — a shared
undo/redo stack. It's scene-level, not per-object: Ctrl+Z always undoes
whatever happened most recently, regardless of which tool or which
object produced it.

## How to use it
- **Ctrl+Z** (or Cmd+Z on Mac) — undo.
- **Ctrl+Shift+Z** or **Ctrl+Y** — redo.
- Or use the **Undo** / **Redo** buttons in the History panel section.

Undo/redo refuses to run while a modal tool (Extrude, Scale, Loop Cut,
Bevel, Move, Delete) is mid-drag, the same way Clear Scene already does
— applying a snapshot mid-drag would pull the mesh out from under a
tool that's still holding a handle into it.

## What is visible
- The scene jumps directly to the previous (or next) state — no
  animation, matching how every other topology change here is already
  instant rather than tweened.
- Selection is always cleared across an undo/redo, the same as every
  topology-mutating tool already clears selection when it starts.
- The Tweakpane **History → ^Z Undo/Redo** row reports what just
  happened ("Undid: Bevel", "Nothing to redo", etc.).

## How it works technically
The obvious approach — give every operation module (`bevel.ts`,
`extrude.ts`, `loopCut.ts`, `scale.ts`, `delete.ts`) a "redo" function
that mirrors its existing `cancel*()` — was rejected. Each module's
`cancel*()` only works because it's called immediately after its own
`begin*()`, restoring the *exact* objects it just created; reusing those
same handles for a general-purpose undo stack breaks the moment
operations compound (undoing operation A after operation B has already
touched A's geometry corrupts both, unless undo is strictly LIFO *and*
every module's redo path re-derives the same object identities the
original begin did — which `new HEVertex(...)`/`new HEFace(...)` calls
don't guarantee across repeated runs). Writing five parallel "redo"
functions by hand would double the surface area for exactly the kind of
subtle twin-wiring bug this project has already hit once.

Instead, `src/operations/History.ts` snapshots the **whole scene** as
plain data — each primitive's position plus its currently-rendered
geometry's raw position/index buffers, read directly off `mesh.geometry`
(kept in sync by every tool's `refreshPrimitive()` call) rather than
re-derived from the `HalfEdgeMesh`. Undo/redo apply a snapshot by
wiping every primitive (`viewport.clearMeshes()`) and rebuilding each
one from scratch. No object reference is ever reused across a snapshot
boundary, so out-of-order or compounding operations can't corrupt
anything — each snapshot is a fully self-contained description of "what
the scene should look like now," not a diff against its neighbor.

**A real bug this surfaced**: rebuilding from a snapshot originally
reused `HalfEdgeMesh.fromBufferGeometry()`, the same method that imports
a fresh Three.js primitive — which merges buffer vertices sharing a
position, since a fresh `BoxGeometry`'s duplicate seam vertices really
are the same physical point. But a face extruded at distance 0 (press
E, click without moving the mouse) legitimately has two *distinct*
`HEVertex` objects sitting at the exact same spot until it's dragged
apart. Restoring that state through the merging import path silently
collapsed the two back into one, corrupting the topology — reachable in
practice via extrude-with-no-mouse-movement → confirm → Undo → Redo.
Fixed by giving `HalfEdgeMesh` a second constructor,
`fromBufferGeometryExact()`, that skips the position-merge entirely;
`History.ts` always uses this variant, since every position slot in its
own `toBufferGeometry()` output is already known to be a distinct
topological vertex with nothing to merge. `fromBufferGeometry()` itself
is untouched for genuine imports (Add Primitive), where merging is
still the correct behavior.

**A second, independent bug this surfaced**: `toBufferGeometry()` used
to index its position/index buffers by each vertex's permanent `.id`
field. `.id` is assigned once at creation and never renumbered;
Extrude/Scale/Bevel/Loop Cut only ever *add* vertices, so ids stayed a
contiguous `0..(vertices.length-1)` range under those alone — but
Delete removes vertices from the array without renumbering the
survivors, leaving gaps. A surviving vertex's `.id` could then exceed
`vertices.length`, silently writing past the end of the position typed
array (no error, no growth — just dropped) and corrupting the rendered
geometry. This was already live in the shipped Delete feature before
History existed; `validate()` never caught it because it only checks
half-edge/topology consistency, not buffer serialization. Fixed by
building a fresh, contiguous 0-based index per `toBufferGeometry()`
call from a `Map<HEVertex, number>`, rather than trusting `.id` to
still equal an array slot.

Both bugs were caught by testing the actual snapshot/restore mechanism
against real compounding operation sequences (bevel → delete → extrude,
undone and redone out of linear order), not just by typechecking or by
each operation module's own isolated tests passing `validate()`.

**Recording an action**: each tool calls `history.beginAction(label)`
immediately before its own `begin*()` call (capturing the *pre*-action
snapshot, since the mutation happens immediately and irreversibly),
then `history.commitAction()` from its `confirm()` or
`history.discardAction()` from its `cancel()`/catch block. Add
Primitive and Clear Scene do the same around their own instant
mutations, with no drag phase to bracket.

## Files involved
- `src/operations/History.ts` — snapshot capture/apply, the undo/redo
  stacks, and the Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y keyboard handling
- `src/mesh/Halfedgemesh.ts` — `fromBufferGeometryExact()` (the
  no-merge import variant History relies on) and the `toBufferGeometry()`
  id-gap fix
- Every tool (`MoveTool.ts`, `DeleteTool.ts`, `ExtrudeTool.ts`,
  `ScaleTool.ts`, `LoopCutTool.ts`, `BevelTool.ts`) — each brackets its
  own `start()`/`confirm()`/`cancel()` with `beginAction()`/
  `commitAction()`/`discardAction()`
- `src/ui/gui.ts` — the History panel's status row and Undo/Redo buttons,
  and the Add Primitive/Clear Scene action recording
- `src/operations/InteractionLock.ts` — undo/redo refuse to run while
  a modal tool holds the lock

## Known limitations
- Whole-scene snapshots, not per-object diffs — cheap and simple at
  this project's scale (a handful of primitives, each a few hundred
  triangles at most), but would need a smarter incremental design if
  scenes grew much larger.
- No persistence — the undo/redo stacks live in memory only and are
  lost on page reload, same as the rest of the scene.
- Capped at 100 entries (`History.MAX_ENTRIES`); older entries are
  silently dropped rather than growing memory unbounded.
