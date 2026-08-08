import * as THREE from 'three';
import { HalfEdgeMesh, HEVertex, HEFace, HalfEdge } from '../mesh/Halfedgemesh.ts';
import type { SelectableFace } from '../mesh/Halfedgemesh.ts';

/**
 * A handle to an in-progress extrude (face or vertex), returned by
 * beginFaceExtrude() / beginVertexExtrude(). Pass it to
 * updateExtrudeDistance() on every mouse-move while dragging, and to
 * either commitExtrude() or cancelExtrude() when the user finishes.
 *
 * Modeled after Blender's modal operator pattern: pressing E performs the
 * topology change immediately (at distance 0, so nothing looks different
 * yet), then mouse movement only repositions already-created vertices —
 * it never re-runs topology construction. Live dragging is just "move
 * some vertices," not "rebuild the mesh every frame."
 */
export interface ExtrudeHandle {
    mesh: HalfEdgeMesh;
    normal: THREE.Vector3;
    newVertices: HEVertex[];
    /** Base (distance-0) position for each new vertex — update() offsets from here, not the vertex's current position, so repeated drags don't accumulate error. */
    basePositions: Map<HEVertex, THREE.Vector3>;
    newFaces: HEFace[];
    /** Exact (edge -> original vertex) pairs recorded before mutation, so cancel can restore them exactly rather than infer them. */
    originalAssignment: Map<HalfEdge, HEVertex>;
    /**
     * For face extrude: each boundary edge's twin exactly as it was before
     * beginFaceExtrude() rewired it to point at the new wall, so cancel can
     * restore the original neighbor link. Empty for vertex/tip extrude,
     * which never rewires an existing edge's twin (only new edges are
     * twinned together).
     */
    originalBoundaryTwins: Map<HalfEdge, HalfEdge | null>;
    /**
     * The subset of `newVertices` that are genuinely new HEVertex objects
     * (created via `new HEVertex(...)`), as opposed to pre-existing
     * vertices that are dragged in place — see beginFaceExtrude's
     * interior-vertex handling. cancelExtrude() removes only these from
     * the mesh; the rest are original vertices it must leave alone.
     */
    createdVertices: HEVertex[];
}

/**
 * Begins an extrude on a single selected face, performing the topology
 * mutation immediately at distance 0 (new geometry exists but is
 * coincident with the original face — invisible until moved).
 *
 * Single-face extrude only (per plan.md's Known Challenges — multi-face
 * extrude requires distinguishing outer-selection boundary edges from
 * edges shared between selected faces, which is out of scope here).
 *
 * The input `group` may be several coplanar triangles (e.g. a cube face is
 * 2 triangles sharing a diagonal) — the whole group is extruded as one
 * logical face using its outer boundary loop, not per-triangle, so the
 * internal diagonal is preserved rather than incorrectly pulled outward.
 */
export function beginFaceExtrude(mesh: HalfEdgeMesh, group: SelectableFace): ExtrudeHandle {
    const boundary = mesh.getBoundaryLoop(group);
    const boundaryInfo = boundary.map((edge) => ({
        edge,
        oldOrigin: edge.origin,
        oldDest: edge.vertex,
    }));

    const normal = group.triangles[0].normal();
    const newFaces: HEFace[] = [];

    // Record the group's exact original (edge -> vertex) assignment before
    // any mutation, so cancelExtrude() can restore it exactly rather than
    // infer it from the resulting topology.
    const originalAssignment = new Map<HalfEdge, HEVertex>();
    for (const face of group.triangles) {
        for (const edge of face.edges()) {
            originalAssignment.set(edge, edge.vertex);
        }
    }

    // 1. Clone each BOUNDARY vertex AT THE SAME POSITION (distance 0) — the
    // live drag moves these afterward via updateExtrudeDistance(). A
    // boundary vertex needs a genuine clone because it plays two roles at
    // once: the original stays behind to anchor the new wall and the
    // untouched exterior mesh, while a fresh copy becomes part of the
    // moving cap.
    //
    // A coplanar group can also have INTERIOR vertices that touch no
    // boundary edge — e.g. a Cylinder cap is triangulated as a fan from a
    // hub vertex out to the rim, and the hub is shared by every triangle in
    // the group but never appears as a boundary-loop origin. Nothing
    // outside the group references an interior vertex, so it doesn't need
    // a second role or a clone — it can just move. Cloning it anyway (an
    // earlier version of this function did) leaves the original behind as
    // a dangling vertex with no real half-edge pointing at it, so interior
    // vertices are tracked separately below and dragged in place instead.
    const groupVertices = new Set<HEVertex>();
    for (const face of group.triangles) {
        for (const v of face.vertices()) groupVertices.add(v);
    }
    const boundaryVertexSet = new Set(boundaryInfo.map((b) => b.oldOrigin));
    const interiorVertices = Array.from(groupVertices).filter((v) => !boundaryVertexSet.has(v));

    const oldToNew = new Map<HEVertex, HEVertex>();
    const basePositions = new Map<HEVertex, THREE.Vector3>();
    for (const { oldOrigin } of boundaryInfo) {
        if (oldToNew.has(oldOrigin)) continue;
        const newVertex = new HEVertex(mesh.vertices.length, oldOrigin.position.clone());
        mesh.vertices.push(newVertex);
        oldToNew.set(oldOrigin, newVertex);
        basePositions.set(newVertex, oldOrigin.position.clone());
    }
    for (const v of interiorVertices) {
        basePositions.set(v, v.position.clone());
    }

    // 2. Re-point every triangle in the group to the new vertices. Only
    // `.vertex` (destination) fields are reassigned. Since each boundary
    // edge's origin is DERIVED from the previous boundary edge's
    // (also-reassigned) destination, this single pass correctly updates
    // both endpoints of every boundary edge without touching `.prev`
    // directly — verified by trace before this was first written.
    for (const face of group.triangles) {
        for (const edge of face.edges()) {
            const replacement = oldToNew.get(edge.vertex);
            if (replacement) edge.vertex = replacement;
        }
    }

    // 3. Build one wall quad (2 triangles) per boundary edge:
    //   oldOrigin -> oldDest -> newDest -> newOrigin -> (back to oldOrigin)
    // split along the oldOrigin-newDest diagonal into:
    //   bottomTri: oldOrigin, oldDest, newDest
    //   topTri:    oldOrigin, newDest, newOrigin
    interface Wall {
        bottom: HalfEdge; // oldOrigin -> oldDest: twins with the original outside neighbor
        right: HalfEdge; // oldDest -> newDest: vertical, twins with the next wall's left
        left: HalfEdge; // newOrigin -> oldOrigin: vertical, twins with the previous wall's right
    }
    const wallByOldOrigin = new Map<HEVertex, Wall>();
    const originalBoundaryTwins = new Map<HalfEdge, HalfEdge | null>();

    for (const { edge: oldEdge, oldOrigin, oldDest } of boundaryInfo) {
        const newOrigin = oldToNew.get(oldOrigin)!;
        const newDest = oldToNew.get(oldDest)!;

        const bottomTri = makeTriangle(mesh, oldOrigin, oldDest, newDest);
        const topTri = makeTriangle(mesh, oldOrigin, newDest, newOrigin);
        newFaces.push(bottomTri, topTri);

        const bottom = findEdge(bottomTri, oldOrigin, oldDest);
        const right = findEdge(bottomTri, oldDest, newDest);
        const bottomDiagonal = findEdge(bottomTri, newDest, oldOrigin);

        const topDiagonal = findEdge(topTri, oldOrigin, newDest);
        const top = findEdge(topTri, newDest, newOrigin);
        const left = findEdge(topTri, newOrigin, oldOrigin);

        // Each wall's own internal diagonal twins with itself.
        bottomDiagonal.twin = topDiagonal;
        topDiagonal.twin = bottomDiagonal;

        // Record oldEdge's pristine twin (the untouched exterior neighbor,
        // or null if this was already a mesh boundary edge) before rewiring
        // it below, so cancelExtrude() can restore this exact link. Without
        // this, cancel deletes `bottom`/`top` while both this edge and its
        // former neighbor are left with `.twin` pointing at the now-deleted
        // half-edge — a dangling reference validate() can't detect, because
        // each orphaned pair is still mutually consistent with itself.
        originalBoundaryTwins.set(oldEdge, oldEdge.twin);

        // Bottom inherits the original boundary edge's twin — the untouched
        // mesh geometry on the outside of the extruded face.
        bottom.twin = oldEdge.twin;
        if (oldEdge.twin) oldEdge.twin.twin = bottom;

        // Top twins with the cap's own boundary edge for this span. After
        // step 2, oldEdge now runs newOrigin -> newDest (both endpoints
        // updated) — the exact reverse of `top` (newDest -> newOrigin) — so
        // they are twins.
        top.twin = oldEdge;
        oldEdge.twin = top;

        wallByOldOrigin.set(oldOrigin, { bottom, right, left });
    }

    // 4. Wire vertical wall-to-wall twins. This wall's `right`
    // (oldDest -> newDest) twins with the next wall's `left`
    // (newOrigin -> oldOrigin), where the next wall in boundary order starts
    // where this one ends (next wall's oldOrigin === this wall's oldDest).
    for (let i = 0; i < boundaryInfo.length; i++) {
        const thisWall = wallByOldOrigin.get(boundaryInfo[i].oldOrigin)!;
        const nextInfo = boundaryInfo[(i + 1) % boundaryInfo.length];
        const nextWall = wallByOldOrigin.get(nextInfo.oldOrigin)!;
        thisWall.right.twin = nextWall.left;
        nextWall.left.twin = thisWall.right;
    }

    mesh.invalidateSelectableFaces();

    const createdVertices = Array.from(oldToNew.values());

    return {
        mesh,
        normal,
        // Both the boundary clones AND the in-place interior vertices need
        // to be dragged; only the clones (createdVertices) get deleted on
        // cancel.
        newVertices: [...createdVertices, ...interiorVertices],
        basePositions,
        newFaces,
        originalAssignment,
        originalBoundaryTwins,
        createdVertices,
    };
}

/**
 * Repositions the extruded vertices along the face normal to the given
 * distance, measured from each vertex's distance-0 base position (not
 * its current position), so repeated calls during a drag don't
 * accumulate floating-point error. Cheap: only updates positions, never
 * rebuilds topology. Distance may be negative (push inward) or zero.
 */
export function updateExtrudeDistance(handle: ExtrudeHandle, distance: number): void {
    for (const v of handle.newVertices) {
        const base = handle.basePositions.get(v)!;
        v.position.copy(base).addScaledVector(handle.normal, distance);
    }
}

/**
 * Repositions vertex/tip-extrude geometry by an arbitrary 3D world-space
 * offset from each vertex's distance-0 base position. Unlike
 * updateExtrudeDistance() — correct for face extrude, where the face's own
 * normal is the one sensible push direction — a vertex "spike" has no
 * single correct direction: Blender lets you drag it anywhere, since it's
 * new geometry that isn't pulling an existing surface along with it.
 * `offset` is typically built by the caller from mouse movement projected
 * onto the camera's view plane (see ExtrudeTool), not constrained to
 * handle.normal at all.
 */
export function updateExtrudeOffset(handle: ExtrudeHandle, offset: THREE.Vector3): void {
    for (const v of handle.newVertices) {
        const base = handle.basePositions.get(v)!;
        v.position.copy(base).add(offset);
    }
}

/**
 * Confirms the extrude at its current position. A no-op beyond what
 * updateExtrudeDistance() already applied — kept as an explicit, named
 * step so calling code has a clear "I'm done" to pair with
 * cancelExtrude().
 */
export function commitExtrude(_handle: ExtrudeHandle): void {
    // Intentionally empty.
}

/**
 * Cancels an in-progress extrude: removes every vertex and face that
 * beginExtrude() created, and restores the group's triangles to their
 * exact original (edge -> vertex) assignment recorded before mutation —
 * not inferred from the resulting topology, so this is exact regardless
 * of mesh shape.
 */
export function cancelExtrude(handle: ExtrudeHandle): void {
    const { mesh, newVertices, newFaces, originalAssignment, originalBoundaryTwins, createdVertices, basePositions } = handle;

    // Restore the group's triangles to exactly what they pointed to before
    // beginExtrude() ran.
    for (const [edge, originalVertex] of originalAssignment) {
        edge.vertex = originalVertex;
    }

    // Restore each boundary edge's twin link to the untouched exterior
    // neighbor (or null) it had before beginFaceExtrude() rewired it.
    // Must happen before that wall geometry is filtered out below, so both
    // sides of the original link are repaired rather than left pointing at
    // a half-edge that's about to be deleted.
    for (const [oldEdge, originalTwin] of originalBoundaryTwins) {
        oldEdge.twin = originalTwin;
        if (originalTwin) originalTwin.twin = oldEdge;
    }

    // Snap every dragged vertex back to its pre-drag position. For the
    // vertices about to be deleted below this is moot, but for vertices
    // that were dragged IN PLACE rather than cloned (beginFaceExtrude's
    // interior vertices — e.g. a Cylinder cap's hub) this is the only
    // place their position gets restored, since they're never removed.
    for (const v of newVertices) {
        const base = basePositions.get(v);
        if (base) v.position.copy(base);
    }

    // Remove the new faces (and their half-edges) and the genuinely new
    // vertices. Vertices present in newVertices but NOT createdVertices
    // were only dragged in place (never cloned) and must be left alone —
    // they're original mesh vertices the just-restored triangles above
    // still reference.
    const newFaceSet = new Set(newFaces);
    const createdVertexSet = new Set(createdVertices);
    mesh.faces = mesh.faces.filter((f) => !newFaceSet.has(f));
    mesh.halfEdges = mesh.halfEdges.filter((he) => !newFaceSet.has(he.face));
    mesh.vertices = mesh.vertices.filter((v) => !createdVertexSet.has(v));

    // Original vertices may have had .halfEdge pointing at a now-removed
    // wall edge — repoint to a surviving half-edge that still terminates
    // there.
    for (const [edge, originalVertex] of originalAssignment) {
        if (!originalVertex.halfEdge || newFaceSet.has(originalVertex.halfEdge.face)) {
            originalVertex.halfEdge = edge;
        }
    }

    mesh.invalidateSelectableFaces();
}

/**
 * Begins an extrude on a single selected vertex, performing the topology
 * mutation immediately at distance 0 (new vertex exists at the same
 * position as the original — invisible until moved).
 *
 * Unlike face extrude, this does NOT create new wall surface — extruding
 * a single existing mesh vertex produces a "whisker": the original
 * vertex's entire ring of connectivity transfers to the new vertex (the
 * new vertex takes over the surrounding surface), and the original
 * vertex is left connected to the new one by a single edge, sticking out
 * as a spike. This matches Blender's actual behavior for E on a lone
 * vertex (as opposed to an edge or face, which DO sweep out new surface).
 *
 * Since every half-edge in this structure must belong to a triangular
 * face (see HEFace's required `face` field throughout HalfEdgeMesh), the
 * single new edge is represented as a pair of degenerate (zero-area at
 * distance 0) triangles sharing that edge, using a fresh SYNTHETIC third
 * corner (not a reused mesh vertex — see the synthetic-corner comment
 * inline below for why). Both triangles' other two edges are genuine new
 * boundary edges (no twin) — expected, same as any mesh boundary (e.g.
 * PlaneGeometry), not a validation error.
 *
 * Only supports INTERIOR vertices (full closed ring) — see
 * HalfEdgeMesh.getVertexRing(), which throws for boundary vertices.
 */
export function beginVertexExtrude(mesh: HalfEdgeMesh, vertex: HEVertex): ExtrudeHandle {
    const ring = mesh.getVertexRing(vertex);

    // Average normal of the triangles touching this vertex — used as the
    // whisker's drag direction. A single vertex has no inherent "normal"
    // the way a flat face does, so this is the closest reasonable analog.
    const normal = new THREE.Vector3();
    for (const spoke of ring) {
        normal.add(spoke.face.normal());
    }
    normal.divideScalar(ring.length).normalize();

    // Record the exact original (edge -> vertex) assignment for every
    // half-edge that terminates at `vertex` within the ring's triangles,
    // before any mutation, so cancel can restore it exactly.
    const originalAssignment = new Map<HalfEdge, HEVertex>();
    for (const spoke of ring) {
        const intoVertex = spoke.next.next; // terminates at `vertex` in this triangle
        originalAssignment.set(intoVertex, intoVertex.vertex);
    }

    const newVertex = new HEVertex(mesh.vertices.length, vertex.position.clone());
    mesh.vertices.push(newVertex);
    // `vertex` — not `newVertex` — is the one that gets dragged; see the
    // note on the returned `newVertices` below for why.
    const basePositions = new Map<HEVertex, THREE.Vector3>([[vertex, vertex.position.clone()]]);

    // Reference scale for the synthetic corner's offset below: the average
    // length of this vertex's own ring spokes, so the whisker's thickness
    // looks proportionate whether the mesh is tiny or huge.
    let avgSpokeLength = 0;
    for (const spoke of ring) {
        avgSpokeLength += spoke.vertex.position.distanceTo(vertex.position);
    }
    avgSpokeLength /= ring.length;

    // Reassign the ring off `vertex` onto `newVertex`. Verified by trace:
    // reassigning only each spoke's "into vertex" destination correctly
    // moves BOTH endpoints of every ring edge, since origins are derived
    // from .prev.vertex, which is exactly the previous ring edge's
    // (also-reassigned) destination.
    for (const spoke of ring) {
        spoke.next.next.vertex = newVertex;
    }

    // Build the whisker: 2 triangles sharing the vertex -> newVertex edge.
    // The third corner is a SYNTHETIC vertex — not reused from the mesh —
    // because reusing a real neighbor (as an earlier version of this
    // function did) creates a directed edge to that neighbor which a LATER
    // extrude of the same tip vertex would collide with (that neighbor
    // already has an edge from/to this whisker).
    //
    // Critically, the synthetic corner needs a genuine offset AWAY from
    // vertex/newVertex, not a third clone sitting exactly on top of one of
    // them — two coincident corners make a triangle's area exactly zero
    // *no matter where the third corner ends up*, so a whisker built that
    // way is topologically real but renders as literally nothing, at any
    // drag distance. Offsetting it a small, fixed distance perpendicular
    // to the drag direction — and leaving it un-dragged, anchored at the
    // base alongside `newVertex` — makes the whisker a thin wedge that
    // tapers from that small base width down to a point at the dragged
    // tip, which is the closest a triangle-only mesh can get to Blender's
    // true 1D edge extrude.
    const perpendicular = pickPerpendicular(normal);
    const offsetAmount = Math.max(avgSpokeLength * 0.12, 0.02);
    const syntheticCorner = new HEVertex(
        mesh.vertices.length,
        vertex.position.clone().addScaledVector(perpendicular, offsetAmount)
    );
    mesh.vertices.push(syntheticCorner);

    const triA = makeTriangle(mesh, vertex, newVertex, syntheticCorner);
    const triB = makeTriangle(mesh, newVertex, vertex, syntheticCorner);

    const sharedA = findEdge(triA, vertex, newVertex); // vertex -> newVertex
    const sharedB = findEdge(triB, newVertex, vertex); // newVertex -> vertex
    sharedA.twin = sharedB;
    sharedB.twin = sharedA;
    // The remaining 4 edges (newVertex->syntheticCorner, syntheticCorner->vertex
    // in triA; vertex->syntheticCorner, syntheticCorner->newVertex in triB) are
    // genuine boundary edges — nothing on the other side of them, same as
    // any mesh boundary. Left with twin === null intentionally.
    syntheticCorner.halfEdge = findEdge(triA, newVertex, syntheticCorner);

    // CRITICAL: explicitly refresh vertex.halfEdge to point at sharedB
    // (newVertex -> vertex, an edge that genuinely terminates at vertex).
    // makeTriangle()'s "if (!x.halfEdge) x.halfEdge = ..." guard only fills
    // in a MISSING reference — it will NOT overwrite vertex.halfEdge if it
    // already pointed somewhere (which it always does after mesh
    // construction). Left unfixed, vertex.halfEdge stays pointed at
    // whatever edge it had BEFORE the ring reassignment moved that edge
    // over to newVertex — a stale reference that silently breaks any
    // future getVertexRing(vertex) call, since that method starts its walk
    // from vertex.halfEdge.twin.
    vertex.halfEdge = sharedB;
    // Same reasoning applies to newVertex, though it's freshly created so
    // its halfEdge is definitely null right now — set it explicitly anyway
    // rather than rely on makeTriangle's fallback ordering, for clarity and
    // to be robust if construction order here ever changes.
    newVertex.halfEdge = sharedA;

    mesh.invalidateSelectableFaces();

    return {
        mesh,
        normal,
        // Only `vertex` (the ORIGINAL vertex) is dragged, not `newVertex`
        // and not `syntheticCorner`. The ring reassignment above hands the
        // surrounding surface to `newVertex`, so it must stay exactly
        // where the original vertex was — dragging it instead (an earlier
        // version of this function did) drags the whole neighboring ring
        // along with it. `syntheticCorner` stays anchored at its offset
        // near the base too, so the whisker tapers from a small fixed
        // width down to a point at the tip rather than staying a constant
        // width or (worse) collapsing to zero area — see the comment above
        // where it's created. `vertex` is the free end left "sticking out
        // as a spike," per this function's own doc comment above.
        newVertices: [vertex],
        basePositions,
        newFaces: [triA, triB],
        originalAssignment,
        // Vertex extrude never rewires an existing edge's twin (the ring's
        // edges only get reassigned to a new vertex, and the whisker's own
        // twin pair is between two brand-new edges) — nothing to restore.
        originalBoundaryTwins: new Map(),
        // newVertex and syntheticCorner are genuinely new objects; `vertex`
        // is the original mesh vertex and must NOT be deleted on cancel —
        // only its position gets reset, handled generically in cancelExtrude.
        createdVertices: [newVertex, syntheticCorner],
    };
}

/**
 * A vertex is a "tip" (the end of an existing whisker, produced by a
 * prior beginVertexExtrude) if it has exactly one twinned (spine) edge
 * and exactly 2 boundary (twin === null) edges. getVertexRing() rejects
 * such vertices since their ring doesn't close; this detects that
 * specific, expected shape so beginTipExtrude() can handle it instead of
 * just failing.
 */
function detectTipVertex(mesh: HalfEdgeMesh, vertex: HEVertex): { spine: HalfEdge; boundary: [HalfEdge, HalfEdge] } | null {
    const touching = mesh.halfEdges.filter((e) => e.origin === vertex || e.vertex === vertex);
    const spineEdges = touching.filter((e) => e.twin !== null);
    const boundaryEdges = touching.filter((e) => e.twin === null);

    // A twinned spine edge appears twice in `touching` (both directions),
    // so 2 spine entries + exactly 2 boundary entries matches a tip.
    if (spineEdges.length !== 2 || boundaryEdges.length !== 2) return null;

    // Normalize to the OUTGOING spine half-edge (origin === vertex).
    const spine = spineEdges.find((e) => e.origin === vertex);
    if (!spine) return null;

    return { spine, boundary: [boundaryEdges[0], boundaryEdges[1]] };
}

/**
 * Begins an extrude on the TIP of an existing whisker (a vertex
 * previously created by beginVertexExtrude, now itself selected for
 * further extrusion) — extends the whisker by one more segment.
 *
 * The tip's existing 2 degenerate triangles (which currently hold both
 * its spine connection back to the rest of the mesh AND its boundary
 * "closure" edges) are fully rebuilt with a NEW tip vertex taking over
 * the old tip's role in them, then a fresh whisker pair (same pattern as
 * beginVertexExtrude, with its own synthetic corner) connects the old
 * tip to the new one. This two-step rebuild is necessary rather than a
 * simple reassignment because the old tip and new tip must coexist as
 * DIFFERENT points within what would otherwise be the same triangle —
 * impossible in a 3-cornered face — so those faces have to be replaced,
 * not just relabeled.
 *
 * Falls back to a regular error (via detectTipVertex returning null) if
 * `vertex` isn't a genuine tip shape — callers should attempt
 * beginVertexExtrude first and only try this if that throws.
 */
export function beginTipExtrude(mesh: HalfEdgeMesh, vertex: HEVertex): ExtrudeHandle {
    const tip = detectTipVertex(mesh, vertex);
    if (!tip) {
        throw new Error(
            `beginTipExtrude: vertex ${vertex.id} is not a whisker-tip shape (expected exactly 1 spine + 2 boundary edges).`
        );
    }
    const { spine, boundary } = tip;
    const spinePartner = spine.vertex; // S: the real mesh-surface point this tip connects to

    // Direction: the tip's own spine, since there's no surrounding surface
    // to average a normal from (that's the whole point of a tip).
    const normal = vertex.position.clone().sub(spinePartner.position).normalize();

    // Record the tip's OLD (edge -> vertex) assignment across both its
    // degenerate faces, before any mutation, so cancel can restore it
    // exactly. This includes the spine edge's own destination where
    // relevant and both boundary edges.
    const originalAssignment = new Map<HalfEdge, HEVertex>();
    for (const face of [spine.face, spine.twin!.face]) {
        for (const edge of face.edges()) {
            originalAssignment.set(edge, edge.vertex);
        }
    }

    // 1. Create the new tip vertex (distance 0, same position as the old tip).
    const newVertex = new HEVertex(mesh.vertices.length, vertex.position.clone());
    mesh.vertices.push(newVertex);
    // `vertex` (the OLD tip) is what gets dragged, matching
    // beginVertexExtrude — see the returned `newVertices` below.
    const basePositions = new Map<HEVertex, THREE.Vector3>([[vertex, vertex.position.clone()]]);
    // 2. Rebuild the tip's 2 old degenerate faces with newVertex replacing
    // vertex everywhere. Every half-edge in EITHER face that terminated at
    // `vertex` gets reassigned to `newVertex` — this includes the spine's
    // destination-facing side and both boundary edges' vertex-facing sides.
    for (const [edge, oldTarget] of originalAssignment) {
        if (oldTarget === vertex) edge.vertex = newVertex;
    }

    // 3. Attach a fresh whisker pair connecting the OLD tip (now vacated,
    // touching nothing) to the NEW tip — identical pattern to
    // beginVertexExtrude's own whisker, including giving the synthetic
    // corner a real perpendicular offset (not a coincident clone) so the
    // whisker actually renders instead of staying permanently zero-area —
    // see the comment in beginVertexExtrude for why. Reference scale here
    // is the existing spine's length (the segment this tip is already
    // attached to the mesh by).
    const spineLength = vertex.position.distanceTo(spinePartner.position);
    const perpendicular = pickPerpendicular(normal);
    const offsetAmount = Math.max(spineLength * 0.12, 0.02);
    const syntheticCorner = new HEVertex(
        mesh.vertices.length,
        vertex.position.clone().addScaledVector(perpendicular, offsetAmount)
    );
    mesh.vertices.push(syntheticCorner);

    const triA = makeTriangle(mesh, vertex, newVertex, syntheticCorner);
    const triB = makeTriangle(mesh, newVertex, vertex, syntheticCorner);
    const sharedA = findEdge(triA, vertex, newVertex);
    const sharedB = findEdge(triB, newVertex, vertex);
    sharedA.twin = sharedB;
    sharedB.twin = sharedA;

    // vertex now only touches this new whisker pair; refresh its reference.
    vertex.halfEdge = sharedB;
    newVertex.halfEdge = sharedA;

    void boundary; // boundary edges were only needed to CONFIRM the tip shape in detectTipVertex; no longer referenced directly once reassignment (step 2) handles them generically

    mesh.invalidateSelectableFaces();

    return {
        mesh,
        normal,
        // `vertex` (the OLD tip) is dragged, not `newVertex` or
        // `syntheticCorner` — step 2 rebuilt the spine-connected faces to
        // reference `newVertex`, so it must stay fixed at the joint, and
        // `syntheticCorner` stays anchored near it so the whisker tapers to
        // a point at the tip. Same reasoning as beginVertexExtrude.
        newVertices: [vertex],
        basePositions,
        newFaces: [triA, triB],
        originalAssignment,
        // Same reasoning as beginVertexExtrude: no pre-existing edge's twin
        // is ever rewired here, so there's nothing for cancel to restore.
        originalBoundaryTwins: new Map(),
        createdVertices: [newVertex, syntheticCorner],
    };
}

/**
 * Returns a unit vector perpendicular to `dir`, used to give a whisker's
 * synthetic corner a real offset instead of sitting exactly on top of
 * another corner (see beginVertexExtrude/beginTipExtrude). Crosses with a
 * reference axis that isn't (nearly) parallel to `dir`, falling back to a
 * second reference if the first one is too close.
 */
function pickPerpendicular(dir: THREE.Vector3): THREE.Vector3 {
    const reference = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    return new THREE.Vector3().crossVectors(dir, reference).normalize();
}

/**
 * Creates a new triangular HEFace with 3 fresh half-edges connecting the
 * given vertices in order, wired into a closed next/prev loop. Does not
 * set any twin — callers wire those up based on context.
 */
function makeTriangle(mesh: HalfEdgeMesh, a: HEVertex, b: HEVertex, c: HEVertex): HEFace {
    const face = new HEFace(mesh.faces.length);

    const heAB = new HalfEdge(mesh.halfEdges.length);
    mesh.halfEdges.push(heAB);
    const heBC = new HalfEdge(mesh.halfEdges.length);
    mesh.halfEdges.push(heBC);
    const heCA = new HalfEdge(mesh.halfEdges.length);
    mesh.halfEdges.push(heCA);

    heAB.vertex = b;
    heBC.vertex = c;
    heCA.vertex = a;

    heAB.next = heBC;
    heBC.next = heCA;
    heCA.next = heAB;
    heAB.prev = heCA;
    heBC.prev = heAB;
    heCA.prev = heBC;

    heAB.face = face;
    heBC.face = face;
    heCA.face = face;
    face.halfEdge = heAB;

    if (!b.halfEdge) b.halfEdge = heAB;
    if (!c.halfEdge) c.halfEdge = heBC;
    if (!a.halfEdge) a.halfEdge = heCA;

    mesh.faces.push(face);
    return face;
}

/** Finds the half-edge of `face` running from `from` to `to`. Throws if not found (internal invariant). */
function findEdge(face: HEFace, from: HEVertex, to: HEVertex): HalfEdge {
    for (const e of face.edges()) {
        if (e.origin === from && e.vertex === to) return e;
    }
    throw new Error('extrude internal error: expected half-edge not found in generated triangle');
}