import * as THREE from 'three';
import { HalfEdgeMesh, HEVertex, HEFace, HalfEdge } from '../mesh/Halfedgemesh.ts';

/**
 * Bevel: softens a sharp edge by replacing it with two parallel edges and
 * a flat face between them. Scoped to a single interior edge (a face on
 * both sides), one segment only — not Blender's full multi-segment,
 * boundary-capable version.
 *
 * Given beveled edge A-B with triangles F1=(A,B,C1) and F2=(B,A,C2),
 * trimming F1's corner at A to a new offset point A1 (and B to B1) leaves
 * F1's other two edges touching A1/B1 while F1's untouched neighbors
 * still expect the original A/B — that's a hole unless it's closed. Each
 * endpoint gets a fixed 3-triangle fan: one triangle preserves F1's
 * neighbor link, one preserves F2's, and a third bridges the two and
 * closes the strip's end. Total: 10 new triangles (2 trimmed originals,
 * 2 strip, 3+3 end caps) replacing the original 2, with ~15 new twin
 * links.
 *
 * Adjacent/chained bevels sharing a vertex don't collide — each
 * beginBevel() call only touches the 2 triangles on either side of its
 * own edge, so a second bevel just carves its own independent notch.
 */

export interface BevelHandle {
    mesh: HalfEdgeMesh;
    /** [A1, B1, A2, B2] — see beginBevel's internal naming. */
    newVertices: HEVertex[];
    newFaces: HEFace[];
    /** [F1, F2], kept around so cancelBevel can restore them exactly. */
    removedFaces: HEFace[];
    /** Each redirected outside neighbor half-edge, mapped to the original edge it pointed to. */
    redirectedNeighborTwins: Map<HalfEdge, HalfEdge>;
}

/** Default offset distance along each adjacent edge, in world units. */
const DEFAULT_WIDTH = 0.2;

/** Offsets from `from` toward `to`, clamped short of the midpoint so the bevel can't fold over itself. */
function offsetPoint(from: THREE.Vector3, to: THREE.Vector3, width: number): THREE.Vector3 {
    const len = from.distanceTo(to);
    if (len < 1e-9) return from.clone();
    const t = Math.min(width, len * 0.49) / len;
    return from.clone().lerp(to, t);
}

/** Begins a bevel on `edge`. Requires a face on both sides (edge.twin !== null). */
export function beginBevel(mesh: HalfEdgeMesh, edge: HalfEdge, width: number = DEFAULT_WIDTH): BevelHandle {
    if (!edge.twin) {
        throw new Error('Bevel needs a face on both sides of the edge — this edge is on the mesh boundary.');
    }

    const F1 = edge.face;
    const F2 = edge.twin.face;

    const A = edge.origin;
    const B = edge.vertex;

    // F1 = (A, B, C1); read its third vertex and non-beveled edges off the existing loop
    const eBC1 = edge.next; // B -> C1
    const eC1A = eBC1.next; // C1 -> A
    const C1 = eBC1.vertex;

    const eAC2 = edge.twin.next; // A -> C2
    const eC2B = eAC2.next; // C2 -> B
    const C2 = eAC2.vertex;

    const A1 = new HEVertex(mesh.vertices.length, offsetPoint(A.position, C1.position, width));
    mesh.vertices.push(A1);
    const B1 = new HEVertex(mesh.vertices.length, offsetPoint(B.position, C1.position, width));
    mesh.vertices.push(B1);
    const A2 = new HEVertex(mesh.vertices.length, offsetPoint(A.position, C2.position, width));
    mesh.vertices.push(A2);
    const B2 = new HEVertex(mesh.vertices.length, offsetPoint(B.position, C2.position, width));
    mesh.vertices.push(B2);

    const F1trimmed = makeTriangle(mesh, A1, B1, C1);
    const F2trimmed = makeTriangle(mesh, B2, A2, C2);

    // strip quad (B1, A1, A2, B2), split by the B1-A2 diagonal
    const quadT1 = makeTriangle(mesh, B1, A1, A2);
    const quadT2 = makeTriangle(mesh, B1, A2, B2);

    // end caps, 3 triangles per endpoint
    const aCap1 = makeTriangle(mesh, A1, C1, A);
    const aCap2 = makeTriangle(mesh, A, C2, A2);
    const aCapCenter = makeTriangle(mesh, A, A2, A1);
    const bCap1 = makeTriangle(mesh, B, C1, B1);
    const bCap2 = makeTriangle(mesh, C2, B, B2);
    const bCapCenter = makeTriangle(mesh, B, B1, B2);

    const newFaces = [F1trimmed, F2trimmed, quadT1, quadT2, aCap1, aCap2, aCapCenter, bCap1, bCap2, bCapCenter];

    twin(F1trimmed, C1, A1, aCap1, A1, C1);
    twin(F1trimmed, B1, C1, bCap1, C1, B1);
    twin(F1trimmed, A1, B1, quadT1, B1, A1);

    twin(F2trimmed, A2, C2, aCap2, C2, A2);
    twin(F2trimmed, C2, B2, bCap2, B2, C2);
    twin(F2trimmed, B2, A2, quadT2, A2, B2);

    twin(quadT1, A2, B1, quadT2, B1, A2);
    twin(quadT1, A1, A2, aCapCenter, A2, A1);
    twin(quadT2, B2, B1, bCapCenter, B1, B2);

    twin(aCap1, A, A1, aCapCenter, A1, A);
    twin(aCap2, A2, A, aCapCenter, A, A2);
    twin(bCap1, B1, B, bCapCenter, B, B1);
    twin(bCap2, B, B2, bCapCenter, B2, B);

    // Redirect each untouched outside neighbor away from the soon-to-be-removed
    // F1/F2 edge onto the new cap edge taking over that direction. Record the
    // ORIGINAL edge (not the new one) so cancelBevel can restore it.
    const redirectedNeighborTwins = new Map<HalfEdge, HalfEdge>();
    const redirects: [HalfEdge, HalfEdge][] = [
        [eC1A, findEdge(aCap1, C1, A)],
        [eBC1, findEdge(bCap1, B, C1)],
        [eAC2, findEdge(aCap2, A, C2)],
        [eC2B, findEdge(bCap2, C2, B)],
    ];
    for (const [originalEdge, newEdge] of redirects) {
        const neighborEdge = originalEdge.twin;
        if (!neighborEdge) continue;
        redirectedNeighborTwins.set(neighborEdge, originalEdge);
        neighborEdge.twin = newEdge;
        newEdge.twin = neighborEdge;
    }

    const removedFaces = [F1, F2];
    const removedFaceSet = new Set(removedFaces);
    mesh.faces = mesh.faces.filter((f) => !removedFaceSet.has(f));
    mesh.halfEdges = mesh.halfEdges.filter((he) => !removedFaceSet.has(he.face));

    if (!A.halfEdge || removedFaceSet.has(A.halfEdge.face)) A.halfEdge = findEdge(aCap1, C1, A);
    if (!B.halfEdge || removedFaceSet.has(B.halfEdge.face)) B.halfEdge = findEdge(bCap1, B, C1);

    mesh.invalidateSelectableFaces();

    return {
        mesh,
        newVertices: [A1, B1, A2, B2],
        newFaces,
        removedFaces,
        redirectedNeighborTwins,
    };
}

/** No-op — beginBevel() already committed the topology change. */
export function commitBevel(_handle: BevelHandle): void {
    // Intentionally empty.
}

/** Removes the new geometry and restores the two original triangles it replaced. */
export function cancelBevel(handle: BevelHandle): void {
    const { mesh, newVertices, newFaces, removedFaces, redirectedNeighborTwins } = handle;

    for (const [neighborEdge, originalEdge] of redirectedNeighborTwins) {
        neighborEdge.twin = originalEdge;
    }

    const newFaceSet = new Set(newFaces);
    const newVertexSet = new Set(newVertices);
    mesh.faces = mesh.faces.filter((f) => !newFaceSet.has(f)).concat(removedFaces);
    mesh.halfEdges = mesh.halfEdges.filter((he) => !newFaceSet.has(he.face)).concat(removedFaces.flatMap((f) => f.edges()));
    mesh.vertices = mesh.vertices.filter((v) => !newVertexSet.has(v));

    mesh.invalidateSelectableFaces();
}

/** Sets faceA's (fromA->toA) edge and faceB's (fromB->toB) edge as each other's twin. */
function twin(faceA: HEFace, fromA: HEVertex, toA: HEVertex, faceB: HEFace, fromB: HEVertex, toB: HEVertex): void {
    const edgeA = findEdge(faceA, fromA, toA);
    const edgeB = findEdge(faceB, fromB, toB);
    edgeA.twin = edgeB;
    edgeB.twin = edgeA;
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
    throw new Error('bevel internal error: expected half-edge not found in generated triangle');
}

/**
 * Known limitations:
 * - Boundary edges (edge.twin === null) aren't supported.
 * - Only 1 segment — no rounded, multi-segment profile.
 */
