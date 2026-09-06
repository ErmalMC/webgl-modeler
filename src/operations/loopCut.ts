import { HalfEdgeMesh, HEVertex, HEFace, HalfEdge } from '../mesh/Halfedgemesh.ts';
import type { SelectableFace } from '../mesh/Halfedgemesh.ts';

/**
 * Loop Cut: inserts a ring of edges around a strip of quads, slicing
 * through every quad crossed. The mesh is triangulated everywhere, so a
 * "quad" here means a SelectableFace of exactly 2 triangles with a clean
 * 4-edge boundary loop — what every quad face on this project's
 * primitives already looks like. A triangle fan (a Cylinder cap) can't be
 * part of a ring.
 *
 * Two phases: discovery walks outward from the selected edge in both
 * directions without mutating anything, crossing from a quad's exit edge
 * into its twin's quad, until the ring closes or runs out. Cutting then
 * walks the validated ring, splitting each quad into 4 triangles around a
 * shared midpoint pair (reusing the midpoint two consecutive quads
 * already share).
 */

export interface LoopCutHandle {
    mesh: HalfEdgeMesh;
    /** New vertices forming the cut ring, in walk order. */
    newVertices: HEVertex[];
    newFaces: HEFace[];
    /** Original triangles the cut replaces, kept for exact cancel. */
    removedFaces: HEFace[];
    /** Each redirected outside neighbor, mapped to the original edge it pointed to before redirection. */
    redirectedNeighborTwins: Map<HalfEdge, HalfEdge>;
}

interface RingStep {
    group: SelectableFace;
    /** The edge this quad is entered through, P0 -> P1. */
    entry: HalfEdge;
    /** The edge opposite entry in the boundary loop, P2 -> P3, where the ring continues. */
    exit: HalfEdge;
}

/** The quad's 4 boundary edges in order, or null if `group` isn't a genuine quad. */
function tryGetQuadBoundary(mesh: HalfEdgeMesh, group: SelectableFace): HalfEdge[] | null {
    if (group.triangles.length !== 2) return null;
    try {
        const boundary = mesh.getBoundaryLoop(group);
        return boundary.length === 4 ? boundary : null;
    } catch {
        return null;
    }
}

function groupOf(mesh: HalfEdgeMesh, face: HEFace): SelectableFace {
    if (face.groupId === undefined) mesh.getSelectableFaces();
    return mesh.getSelectableFaces()[face.groupId!];
}

/** The edge two positions away from `edge` in a 4-edge boundary loop (directly opposite it). */
function oppositeEdge(boundary: HalfEdge[], edge: HalfEdge): HalfEdge {
    const idx = boundary.indexOf(edge);
    if (idx === -1) {
        throw new Error('Loop Cut: selected edge is a face\'s internal diagonal, not one of its 4 outer edges — select an outer edge instead.');
    }
    return boundary[(idx + 2) % 4];
}

/** Walks the ring in both directions from a starting (group, entry edge) without mutating anything. */
function discoverRing(mesh: HalfEdgeMesh, startGroup: SelectableFace, startEntry: HalfEdge): { steps: RingStep[]; closed: boolean } {
    const startBoundary = tryGetQuadBoundary(mesh, startGroup);
    if (!startBoundary) {
        throw new Error('Loop Cut needs a quad face (a coplanar group made of exactly 2 triangles) on at least one side of the selected edge.');
    }
    oppositeEdge(startBoundary, startEntry); // confirms startEntry isn't a diagonal

    const forward: RingStep[] = [];
    {
        let group = startGroup;
        let entry = startEntry;
        const visited = new Set<SelectableFace>([startGroup]);
        while (true) {
            const boundary = tryGetQuadBoundary(mesh, group)!;
            const exit = oppositeEdge(boundary, entry);
            forward.push({ group, entry, exit });

            if (!exit.twin) break; // genuine mesh boundary — open end
            const nextGroup = groupOf(mesh, exit.twin.face);
            if (nextGroup === startGroup) return { steps: forward, closed: true };
            if (visited.has(nextGroup)) break;
            const nextBoundary = tryGetQuadBoundary(mesh, nextGroup);
            if (!nextBoundary) {
                throw new Error('Loop Cut ring runs into a non-quad face (e.g. a triangle fan) before closing — not supported.');
            }
            visited.add(nextGroup);
            group = nextGroup;
            entry = exit.twin;
        }
    }

    // extend on the other side too, so a non-closing ring still includes the whole strip
    const backward: RingStep[] = [];
    {
        let entry = startEntry;
        const visited = new Set<SelectableFace>([startGroup]);
        while (true) {
            if (!entry.twin) break;
            const prevGroup = groupOf(mesh, entry.twin.face);
            if (visited.has(prevGroup)) break;
            const prevBoundary = tryGetQuadBoundary(mesh, prevGroup);
            if (!prevBoundary) {
                throw new Error('Loop Cut ring runs into a non-quad face (e.g. a triangle fan) before reaching a mesh boundary — not supported.');
            }
            visited.add(prevGroup);
            const prevExit = entry.twin;
            const prevEntry = oppositeEdge(prevBoundary, prevExit);
            backward.push({ group: prevGroup, entry: prevEntry, exit: prevExit });
            entry = prevEntry;
        }
    }

    return { steps: [...backward.reverse(), ...forward], closed: false };
}

/**
 * Re-triangulates one quad around a shared entry/exit midpoint pair.
 * Corners P0..P3 from entry's origin going around: entry P0->P1 (split by
 * entryMid), edgeB P1->P2 (untouched), exit P2->P3 (split by exitMid),
 * edgeD P3->P0 (untouched).
 */
function cutQuad(
    mesh: HalfEdgeMesh,
    step: RingStep,
    entryMid: HEVertex,
    exitMid: HEVertex,
    redirectedNeighborTwins: Map<HalfEdge, HalfEdge>
): { faces: HEFace[]; entrySide: [HalfEdge, HalfEdge]; exitSide: [HalfEdge, HalfEdge] } {
    const boundary = tryGetQuadBoundary(mesh, step.group)!;
    const idx = boundary.indexOf(step.entry);
    const edgeB = boundary[(idx + 1) % 4];
    const edgeD = boundary[(idx + 3) % 4];

    const P0 = step.entry.origin;
    const P1 = step.entry.vertex;
    const P2 = edgeB.vertex;
    const P3 = step.exit.vertex;

    // Record what edgeB/edgeD's outside neighbors pointed to before redirecting, for cancel.
    if (edgeB.twin) redirectedNeighborTwins.set(edgeB.twin, edgeB);
    if (edgeD.twin) redirectedNeighborTwins.set(edgeD.twin, edgeD);

    const t1 = makeTriangle(mesh, P0, entryMid, exitMid);
    const t2 = makeTriangle(mesh, P0, exitMid, P3);
    const t3 = makeTriangle(mesh, entryMid, P1, P2);
    const t4 = makeTriangle(mesh, entryMid, P2, exitMid);

    const cutA = findEdge(t1, entryMid, exitMid);
    const cutB = findEdge(t4, exitMid, entryMid);
    cutA.twin = cutB;
    cutB.twin = cutA;

    // Each half of the split quad is itself 2 triangles sharing its own
    // internal diagonal, distinct from the center cut edge shared between the two halves.
    const leftDiagonalA = findEdge(t1, exitMid, P0);
    const leftDiagonalB = findEdge(t2, P0, exitMid);
    leftDiagonalA.twin = leftDiagonalB;
    leftDiagonalB.twin = leftDiagonalA;

    const rightDiagonalA = findEdge(t3, P2, entryMid);
    const rightDiagonalB = findEdge(t4, entryMid, P2);
    rightDiagonalA.twin = rightDiagonalB;
    rightDiagonalB.twin = rightDiagonalA;

    // edgeB/edgeD are perpendicular to the cut and never split — their replacements inherit the same twin.
    const newEdgeB = findEdge(t3, P1, P2);
    newEdgeB.twin = edgeB.twin;
    if (edgeB.twin) edgeB.twin.twin = newEdgeB;

    const newEdgeD = findEdge(t2, P3, P0);
    newEdgeD.twin = edgeD.twin;
    if (edgeD.twin) edgeD.twin.twin = newEdgeD;

    const entrySide: [HalfEdge, HalfEdge] = [findEdge(t1, P0, entryMid), findEdge(t3, entryMid, P1)];
    const exitSide: [HalfEdge, HalfEdge] = [findEdge(t4, P2, exitMid), findEdge(t2, exitMid, P3)];

    return { faces: [t1, t2, t3, t4], entrySide, exitSide };
}

/** Twins the two split-edge pairs where one quad's exit meets the next quad's entry. */
function stitchSeam(exitSide: [HalfEdge, HalfEdge], entrySide: [HalfEdge, HalfEdge]): void {
    exitSide[0].twin = entrySide[1];
    entrySide[1].twin = exitSide[0];
    exitSide[1].twin = entrySide[0];
    entrySide[0].twin = exitSide[1];
}

/** Cuts through the ring of quads containing `edge`, at the exact midpoint of every edge crossed. */
export function beginLoopCut(mesh: HalfEdgeMesh, edge: HalfEdge): LoopCutHandle {
    const startGroup = groupOf(mesh, edge.face);
    const { steps, closed } = discoverRing(mesh, startGroup, edge);
    const n = steps.length;

    // entryMid[i] === exitMid[i-1] (same physical edge, seen from each side),
    // so a closed ring needs n vertices and an open one needs n+1.
    const midpoints: HEVertex[] = [];
    for (const step of steps) {
        const e = step.entry;
        const pos = e.origin.position.clone().lerp(e.vertex.position, 0.5);
        const v = new HEVertex(mesh.vertices.length, pos);
        mesh.vertices.push(v);
        midpoints.push(v);
    }
    if (closed) {
        midpoints.push(midpoints[0]);
    } else {
        const e = steps[n - 1].exit;
        const pos = e.origin.position.clone().lerp(e.vertex.position, 0.5);
        const v = new HEVertex(mesh.vertices.length, pos);
        mesh.vertices.push(v);
        midpoints.push(v);
    }

    const newFaces: HEFace[] = [];
    const removedFaces: HEFace[] = [];
    const redirectedNeighborTwins = new Map<HalfEdge, HalfEdge>();

    let previousExitSide: [HalfEdge, HalfEdge] | null = null;
    let firstEntrySide: [HalfEdge, HalfEdge] | null = null;

    for (let i = 0; i < n; i++) {
        const step = steps[i];
        removedFaces.push(...step.group.triangles);

        const { faces, entrySide, exitSide } = cutQuad(mesh, step, midpoints[i], midpoints[i + 1], redirectedNeighborTwins);
        newFaces.push(...faces);

        if (i === 0) firstEntrySide = entrySide;
        if (previousExitSide) stitchSeam(previousExitSide, entrySide);
        previousExitSide = exitSide;
    }

    if (closed && previousExitSide && firstEntrySide) {
        stitchSeam(previousExitSide, firstEntrySide);
    }

    const removedFaceSet = new Set(removedFaces);
    mesh.faces = mesh.faces.filter((f) => !removedFaceSet.has(f));
    mesh.halfEdges = mesh.halfEdges.filter((he) => !removedFaceSet.has(he.face));

    mesh.invalidateSelectableFaces();

    return {
        mesh,
        newVertices: closed ? midpoints.slice(0, n) : midpoints,
        newFaces,
        removedFaces,
        redirectedNeighborTwins,
    };
}

/** No-op — beginLoopCut() already committed the topology change. */
export function commitLoopCut(_handle: LoopCutHandle): void {
    // Intentionally empty.
}

/** Removes the new ring and restores the original triangles it replaced. */
export function cancelLoopCut(handle: LoopCutHandle): void {
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
    throw new Error('loopCut internal error: expected half-edge not found in generated triangle');
}
