import * as THREE from 'three';
import { HalfEdgeMesh, HEVertex, HEFace, HalfEdge } from '../mesh/Halfedgemesh.ts';
import type { SelectableFace } from '../mesh/Halfedgemesh.ts';

/**
 * Handle to an in-progress extrude (face or vertex). Pass to
 * updateExtrudeDistance()/updateExtrudeOffset() on every move, then
 * commitExtrude() or cancelExtrude() when done. The topology change
 * happens immediately at distance 0; dragging only repositions vertices.
 */
export interface ExtrudeHandle {
    mesh: HalfEdgeMesh;
    normal: THREE.Vector3;
    newVertices: HEVertex[];
    /** Distance-0 base position per new vertex — updates offset from here, not the current position. */
    basePositions: Map<HEVertex, THREE.Vector3>;
    newFaces: HEFace[];
    /** (edge -> original vertex) pairs recorded before mutation, for exact cancel. */
    originalAssignment: Map<HalfEdge, HEVertex>;
    /** Each boundary edge's pre-extrude twin, for face extrude. Empty for vertex/tip extrude. */
    originalBoundaryTwins: Map<HalfEdge, HalfEdge | null>;
    /** The subset of newVertices that are genuinely new objects (vs. dragged-in-place originals); only these get removed on cancel. */
    createdVertices: HEVertex[];
}

/**
 * Extrudes a single selected face, mutating topology immediately at
 * distance 0. A coplanar group (e.g. a cube face's 2 triangles) is
 * extruded via its outer boundary loop, not per-triangle, so the shared
 * internal diagonal is preserved.
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

    const originalAssignment = new Map<HalfEdge, HEVertex>();
    for (const face of group.triangles) {
        for (const edge of face.edges()) {
            originalAssignment.set(edge, edge.vertex);
        }
    }

    // Clone each boundary vertex at distance 0; a boundary vertex needs a
    // real clone since the original anchors the wall/exterior while the
    // clone becomes part of the moving cap. Interior vertices (e.g. a
    // Cylinder cap's hub) have nothing outside the group referencing them,
    // so they're dragged in place instead of cloned.
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

    // Re-point every triangle's destination in the group to the new
    // vertices; each boundary edge's origin derives from the previous
    // edge's (also reassigned) destination, so both endpoints update.
    for (const face of group.triangles) {
        for (const edge of face.edges()) {
            const replacement = oldToNew.get(edge.vertex);
            if (replacement) edge.vertex = replacement;
        }
    }

    // One wall quad per boundary edge, split along the oldOrigin-newDest diagonal:
    //   bottomTri: oldOrigin, oldDest, newDest
    //   topTri:    oldOrigin, newDest, newOrigin
    interface Wall {
        bottom: HalfEdge;
        right: HalfEdge;
        left: HalfEdge;
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

        bottomDiagonal.twin = topDiagonal;
        topDiagonal.twin = bottomDiagonal;

        // Record the pristine twin before rewiring, so cancel can restore
        // it — otherwise a deleted wall edge leaves the neighbor dangling
        // in a way validate() can't detect (each orphaned pair is still
        // self-consistent).
        originalBoundaryTwins.set(oldEdge, oldEdge.twin);

        bottom.twin = oldEdge.twin;
        if (oldEdge.twin) oldEdge.twin.twin = bottom;

        // oldEdge now runs newOrigin -> newDest after step 2 above — the
        // exact reverse of `top` — so they're twins.
        top.twin = oldEdge;
        oldEdge.twin = top;

        wallByOldOrigin.set(oldOrigin, { bottom, right, left });
    }

    // wall-to-wall twins: this wall's right twins with the next wall's left
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
        newVertices: [...createdVertices, ...interiorVertices],
        basePositions,
        newFaces,
        originalAssignment,
        originalBoundaryTwins,
        createdVertices,
    };
}

/** Moves the extruded vertices along the face normal to `distance`, measured from each vertex's distance-0 base. */
export function updateExtrudeDistance(handle: ExtrudeHandle, distance: number): void {
    for (const v of handle.newVertices) {
        const base = handle.basePositions.get(v)!;
        v.position.copy(base).addScaledVector(handle.normal, distance);
    }
}

/**
 * Moves vertex/tip-extrude geometry by an arbitrary 3D offset from each
 * vertex's base position. A vertex spike has no single correct direction
 * the way a face's normal does, so `offset` is typically built from mouse
 * movement projected onto the camera's view plane.
 */
export function updateExtrudeOffset(handle: ExtrudeHandle, offset: THREE.Vector3): void {
    for (const v of handle.newVertices) {
        const base = handle.basePositions.get(v)!;
        v.position.copy(base).add(offset);
    }
}

/** No-op beyond what updateExtrudeDistance()/updateExtrudeOffset() already applied. */
export function commitExtrude(_handle: ExtrudeHandle): void {
    // Intentionally empty.
}

/** Removes everything beginExtrude() created and restores the group's original (edge -> vertex) assignment. */
export function cancelExtrude(handle: ExtrudeHandle): void {
    const { mesh, newVertices, newFaces, originalAssignment, originalBoundaryTwins, createdVertices, basePositions } = handle;

    for (const [edge, originalVertex] of originalAssignment) {
        edge.vertex = originalVertex;
    }

    // Must happen before the wall geometry below is filtered out, so both
    // sides of the link are repaired rather than left pointing at a
    // half-edge that's about to be deleted.
    for (const [oldEdge, originalTwin] of originalBoundaryTwins) {
        oldEdge.twin = originalTwin;
        if (originalTwin) originalTwin.twin = oldEdge;
    }

    // Interior vertices dragged in place (never cloned, never removed) only get restored here.
    for (const v of newVertices) {
        const base = basePositions.get(v);
        if (base) v.position.copy(base);
    }

    const newFaceSet = new Set(newFaces);
    const createdVertexSet = new Set(createdVertices);
    mesh.faces = mesh.faces.filter((f) => !newFaceSet.has(f));
    mesh.halfEdges = mesh.halfEdges.filter((he) => !newFaceSet.has(he.face));
    mesh.vertices = mesh.vertices.filter((v) => !createdVertexSet.has(v));

    for (const [edge, originalVertex] of originalAssignment) {
        if (!originalVertex.halfEdge || newFaceSet.has(originalVertex.halfEdge.face)) {
            originalVertex.halfEdge = edge;
        }
    }

    mesh.invalidateSelectableFaces();
}

/**
 * Extrudes a single selected vertex, producing a "whisker" rather than
 * new surface: the vertex's whole ring of connectivity transfers to a new
 * vertex, and the original is left connected to it by one edge sticking
 * out as a spike — matching Blender's behavior for extruding a lone
 * vertex.
 *
 * Since every half-edge must belong to a triangle, the new spike edge is
 * represented as a pair of degenerate (zero-area at distance 0) triangles
 * sharing it, with a synthetic third corner. Only supports interior
 * vertices — see HalfEdgeMesh.getVertexRing().
 */
export function beginVertexExtrude(mesh: HalfEdgeMesh, vertex: HEVertex): ExtrudeHandle {
    const ring = mesh.getVertexRing(vertex);

    const normal = new THREE.Vector3();
    for (const spoke of ring) {
        normal.add(spoke.face.normal());
    }
    normal.divideScalar(ring.length).normalize();

    const originalAssignment = new Map<HalfEdge, HEVertex>();
    for (const spoke of ring) {
        const intoVertex = spoke.next.next; // terminates at `vertex` in this triangle
        originalAssignment.set(intoVertex, intoVertex.vertex);
    }

    const newVertex = new HEVertex(mesh.vertices.length, vertex.position.clone());
    mesh.vertices.push(newVertex);
    // `vertex` (not newVertex) is what gets dragged — see the returned newVertices below.
    const basePositions = new Map<HEVertex, THREE.Vector3>([[vertex, vertex.position.clone()]]);

    let avgSpokeLength = 0;
    for (const spoke of ring) {
        avgSpokeLength += spoke.vertex.position.distanceTo(vertex.position);
    }
    avgSpokeLength /= ring.length;

    // Reassigning just each spoke's "into vertex" destination moves both
    // endpoints of every ring edge, since origins derive from .prev.vertex.
    for (const spoke of ring) {
        spoke.next.next.vertex = newVertex;
    }

    // Whisker: 2 triangles sharing the vertex -> newVertex edge. The third
    // corner is synthetic (not a reused mesh vertex) so a later chained
    // extrude of this same tip can't collide with existing geometry, and
    // it needs a real offset (not a coincident clone) or the triangles are
    // permanently zero-area.
    const perpendicular = pickPerpendicular(normal);
    const offsetAmount = Math.max(avgSpokeLength * 0.12, 0.02);
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
    // The remaining 4 edges are genuine boundary edges (twin === null), same as any mesh boundary.
    syntheticCorner.halfEdge = findEdge(triA, newVertex, syntheticCorner);

    // makeTriangle()'s "if (!x.halfEdge)" guard won't overwrite an
    // existing reference, so vertex.halfEdge needs an explicit refresh
    // here or it stays stale after the ring reassignment above.
    vertex.halfEdge = sharedB;
    newVertex.halfEdge = sharedA;

    mesh.invalidateSelectableFaces();

    return {
        mesh,
        normal,
        newVertices: [vertex],
        basePositions,
        newFaces: [triA, triB],
        originalAssignment,
        originalBoundaryTwins: new Map(),
        createdVertices: [newVertex, syntheticCorner],
    };
}

/**
 * A vertex is a whisker "tip" if it has exactly one twinned (spine) edge
 * and 2 boundary edges — getVertexRing() rejects this shape since it
 * doesn't close, so beginTipExtrude() handles it separately.
 */
function detectTipVertex(mesh: HalfEdgeMesh, vertex: HEVertex): { spine: HalfEdge; boundary: [HalfEdge, HalfEdge] } | null {
    const touching = mesh.halfEdges.filter((e) => e.origin === vertex || e.vertex === vertex);
    const spineEdges = touching.filter((e) => e.twin !== null);
    const boundaryEdges = touching.filter((e) => e.twin === null);

    // A twinned spine edge appears twice (both directions), so 2 spine + 2 boundary entries matches a tip.
    if (spineEdges.length !== 2 || boundaryEdges.length !== 2) return null;

    const spine = spineEdges.find((e) => e.origin === vertex);
    if (!spine) return null;

    return { spine, boundary: [boundaryEdges[0], boundaryEdges[1]] };
}

/**
 * Extends an existing whisker by one segment from its tip. The tip's 2
 * degenerate triangles are rebuilt with a new tip vertex taking over the
 * old tip's role, then a fresh whisker pair connects old tip to new tip —
 * they have to coexist as different points, which a 3-cornered face can't
 * do, so the faces are replaced rather than relabeled.
 */
export function beginTipExtrude(mesh: HalfEdgeMesh, vertex: HEVertex): ExtrudeHandle {
    const tip = detectTipVertex(mesh, vertex);
    if (!tip) {
        throw new Error(
            `beginTipExtrude: vertex ${vertex.id} is not a whisker-tip shape (expected exactly 1 spine + 2 boundary edges).`
        );
    }
    const { spine, boundary } = tip;
    const spinePartner = spine.vertex;

    const normal = vertex.position.clone().sub(spinePartner.position).normalize();

    const originalAssignment = new Map<HalfEdge, HEVertex>();
    for (const face of [spine.face, spine.twin!.face]) {
        for (const edge of face.edges()) {
            originalAssignment.set(edge, edge.vertex);
        }
    }

    const newVertex = new HEVertex(mesh.vertices.length, vertex.position.clone());
    mesh.vertices.push(newVertex);
    const basePositions = new Map<HEVertex, THREE.Vector3>([[vertex, vertex.position.clone()]]);

    for (const [edge, oldTarget] of originalAssignment) {
        if (oldTarget === vertex) edge.vertex = newVertex;
    }

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

    vertex.halfEdge = sharedB;
    newVertex.halfEdge = sharedA;

    void boundary; // only needed to confirm the tip shape in detectTipVertex

    mesh.invalidateSelectableFaces();

    return {
        mesh,
        normal,
        newVertices: [vertex],
        basePositions,
        newFaces: [triA, triB],
        originalAssignment,
        originalBoundaryTwins: new Map(),
        createdVertices: [newVertex, syntheticCorner],
    };
}

/** A unit vector perpendicular to `dir`, for a whisker's synthetic corner offset. */
function pickPerpendicular(dir: THREE.Vector3): THREE.Vector3 {
    const reference = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    return new THREE.Vector3().crossVectors(dir, reference).normalize();
}

/** Creates a new triangular HEFace with 3 fresh half-edges. Does not set twins. */
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

/** Finds the half-edge of `face` running from `from` to `to`. */
function findEdge(face: HEFace, from: HEVertex, to: HEVertex): HalfEdge {
    for (const e of face.edges()) {
        if (e.origin === from && e.vertex === to) return e;
    }
    throw new Error('extrude internal error: expected half-edge not found in generated triangle');
}
