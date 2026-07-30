import * as THREE from 'three';

/**
 * Half-edge mesh data structure.
 *
 * Built over the TRIANGULATED geometry — every Face is a single triangle,
 * not a polygon. Three.js primitives (BoxGeometry, etc.) already come out
 * of the box as triangle soup, so this matches what MeshBuilder produces
 * directly. A visual "cube face" is therefore two adjacent HalfEdgeMesh
 * faces sharing a diagonal edge; grouping coplanar triangles into a single
 * selectable "face" is a selection-layer concern, not something this
 * structure tracks itself. See selection/SelectionManager.ts (Week 5/8)
 * for that grouping logic once it exists.
 *
 * Each half-edge knows:
 *  - the vertex it points TO (`vertex`)
 *  - the face it belongs to (`face`)
 *  - the next half-edge around that face (`next`)
 *  - the previous half-edge around that face (`prev`)
 *  - its twin, the opposite half-edge on the neighboring face (`twin`,
 *    or null if this edge is a boundary edge with no neighbor)
 */

export class HEVertex {
    id: number;
    position: THREE.Vector3;
    /** One half-edge that points TO this vertex. Enough to walk the full ring. */
    halfEdge: HalfEdge | null = null;

    constructor(id: number, position: THREE.Vector3) {
        this.id = id;
        this.position = position;
    }
}

export class HalfEdge {
    id: number;
    vertex!: HEVertex; // vertex this half-edge points TO
    face!: HEFace;
    next!: HalfEdge;
    prev!: HalfEdge;
    twin: HalfEdge | null = null;

    constructor(id: number) {
        this.id = id;
    }

    /** Origin vertex (where this half-edge starts). */
    get origin(): HEVertex {
        return this.prev.vertex;
    }

    /** Both endpoints of this half-edge, [origin, destination]. */
    endpoints(): [HEVertex, HEVertex] {
        return [this.origin, this.vertex];
    }
}

export class HEFace {
    id: number;
    /** Any one half-edge on this face's loop. Walk .next three times to get all edges (triangles only). */
    halfEdge!: HalfEdge;

    /**
     * ID of the SelectableFace group this triangle belongs to (see
     * HalfEdgeMesh.getSelectableFaces()). Undefined until that's been
     * computed at least once; stale after any topology change until
     * recomputed.
     */
    groupId: number | undefined = undefined;

    constructor(id: number) {
        this.id = id;
    }

    /** Returns the 3 half-edges forming this triangular face, in loop order. */
    edges(): [HalfEdge, HalfEdge, HalfEdge] {
        const e0 = this.halfEdge;
        const e1 = e0.next;
        const e2 = e1.next;
        return [e0, e1, e2];
    }

    /** Returns the 3 vertices of this triangular face, in loop order. */
    vertices(): [HEVertex, HEVertex, HEVertex] {
        const [e0, e1, e2] = this.edges();
        return [e0.vertex, e1.vertex, e2.vertex];
    }

    /** Computes this triangle's face normal from its vertex positions. */
    normal(): THREE.Vector3 {
        const [va, vb, vc] = this.vertices();
        const edgeAB = new THREE.Vector3().subVectors(vb.position, va.position);
        const edgeAC = new THREE.Vector3().subVectors(vc.position, va.position);
        return new THREE.Vector3().crossVectors(edgeAB, edgeAC).normalize();
    }
}

/**
 * A visually selectable face: one or more coplanar triangles sharing edges,
 * grouped together the way a user expects a single click on a cube face to
 * select the whole face rather than just the triangle under the cursor.
 */
export interface SelectableFace {
    id: number;
    triangles: HEFace[];
}

export interface MeshValidationResult {
    valid: boolean;
    errors: string[];
}

export class HalfEdgeMesh {
    vertices: HEVertex[] = [];
    faces: HEFace[] = [];
    halfEdges: HalfEdge[] = [];

    // Cache for getSelectableFaces(); invalidated by invalidateSelectableFaces(),
    // which any future topology-mutating operation (extrude/bevel/loop cut/
    // scale) must call once it changes vertex positions or face connectivity.
    private selectableFacesCache: SelectableFace[] | null = null;

    /**
     * Builds a HalfEdgeMesh from a triangulated THREE.BufferGeometry.
     * Assumes the geometry is indexed (BoxGeometry, PlaneGeometry,
     * CylinderGeometry, and SphereGeometry all produce indexed geometry by
     * default) and triangulated (draw mode TRIANGLES, the Three.js default).
     *
     * IMPORTANT: Three.js primitive generators duplicate vertices at UV/normal
     * seams — e.g. BoxGeometry has 24 buffer vertices for 8 physical corners,
     * one set of 4 per face, so each face can have distinct UVs/normals.
     * Buffer index is therefore NOT a reliable stand-in for "same physical
     * point." This method merges buffer vertices that share a position
     * (within POSITION_EPSILON) into a single HEVertex before building
     * half-edges, so twin-matching across seams works correctly.
     */
    static fromBufferGeometry(geometry: THREE.BufferGeometry): HalfEdgeMesh {
        const mesh = new HalfEdgeMesh();

        const posAttr = geometry.getAttribute('position');
        const index = geometry.getIndex();
        if (!index) {
            throw new Error(
                'HalfEdgeMesh.fromBufferGeometry requires indexed geometry. ' +
                'Call geometry.toNonIndexed() in reverse (mergeVertices) or ' +
                'ensure the source primitive is indexed.'
            );
        }

        // 1. Merge buffer vertices sharing a position into single HEVertex
        // instances. Quantize position to a grid to build a hash key — exact
        // float equality is unreliable, and primitives here don't produce
        // near-miss coordinates that would need a fuzzier tolerance.
        const POSITION_EPSILON = 1e-5;
        const quantize = (n: number) => Math.round(n / POSITION_EPSILON);
        const posKey = (v: THREE.Vector3) => `${quantize(v.x)}_${quantize(v.y)}_${quantize(v.z)}`;

        const vertexByPos = new Map<string, HEVertex>();
        // bufferIndexToVertex[i] = the (possibly shared) HEVertex for buffer index i
        const bufferIndexToVertex: HEVertex[] = new Array(posAttr.count);

        for (let i = 0; i < posAttr.count; i++) {
            const pos = new THREE.Vector3().fromBufferAttribute(posAttr, i);
            const k = posKey(pos);
            let v = vertexByPos.get(k);
            if (!v) {
                v = new HEVertex(mesh.vertices.length, pos);
                vertexByPos.set(k, v);
                mesh.vertices.push(v);
            }
            bufferIndexToVertex[i] = v;
        }

        // 2. Walk triangles, creating 3 half-edges + 1 face per triangle.
        // Track edges by (fromVertexId, toVertexId) so twins can be resolved
        // in a second pass without an O(n^2) search. IDs here are the merged
        // HEVertex ids, not raw buffer indices.
        const edgeMap = new Map<string, HalfEdge>();
        const key = (a: number, b: number) => `${a}_${b}`;

        for (let t = 0; t < index.count; t += 3) {
            const va = bufferIndexToVertex[index.getX(t)];
            const vb = bufferIndexToVertex[index.getX(t + 1)];
            const vc = bufferIndexToVertex[index.getX(t + 2)];

            const face = new HEFace(mesh.faces.length);

            const heAB = new HalfEdge(mesh.halfEdges.length);
            mesh.halfEdges.push(heAB);
            const heBC = new HalfEdge(mesh.halfEdges.length);
            mesh.halfEdges.push(heBC);
            const heCA = new HalfEdge(mesh.halfEdges.length);
            mesh.halfEdges.push(heCA);

            heAB.vertex = vb;
            heBC.vertex = vc;
            heCA.vertex = va;

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

            // Point each vertex at a half-edge that terminates there, if it
            // doesn't have one yet (any one is enough to start a traversal).
            if (!vb.halfEdge) vb.halfEdge = heAB;
            if (!vc.halfEdge) vc.halfEdge = heBC;
            if (!va.halfEdge) va.halfEdge = heCA;

            edgeMap.set(key(va.id, vb.id), heAB);
            edgeMap.set(key(vb.id, vc.id), heBC);
            edgeMap.set(key(vc.id, va.id), heCA);

            mesh.faces.push(face);
        }

        // 3. Resolve twins: the twin of edge (a->b) is edge (b->a), if it exists.
        // Edges with no twin are boundary edges (expected for e.g. PlaneGeometry,
        // or a genuinely open/non-manifold mesh).
        for (const [k, he] of edgeMap) {
            const [aStr, bStr] = k.split('_');
            const twinKey = key(Number(bStr), Number(aStr));
            const twin = edgeMap.get(twinKey);
            if (twin) {
                he.twin = twin;
            }
        }

        return mesh;
    }

    /**
     * Maps a rendered triangle index (as reported by THREE.Raycaster's
     * intersection.faceIndex) back to the HEFace it came from. Populated by
     * toBufferGeometry() below — the index buffer is built by iterating
     * `faces` in array order, so triangle N in the rendered geometry is
     * faces[N]. This map exists so callers rely on an explicit lookup
     * instead of that ordering as an implicit contract. Rebuilt every time
     * toBufferGeometry() runs, so it always matches whatever is currently
     * displayed on screen.
     */
    private triangleIndexToFace: HEFace[] = [];

    /** Looks up the HEFace for a Three.js raycast intersection.faceIndex. */
    getFaceByTriangleIndex(triangleIndex: number): HEFace | undefined {
        return this.triangleIndexToFace[triangleIndex];
    }

    /**
     * Returns one HalfEdge per physical edge (skips the twin of any edge
     * already returned), for edge-selection hit-testing where testing both
     * half-edges of the same physical edge would be redundant and would
     * make it ambiguous which twin "owns" the edge for highlighting.
     * Boundary half-edges (twin === null) are naturally included once.
     */
    getUniqueEdges(): HalfEdge[] {
        const seen = new Set<HalfEdge>();
        const result: HalfEdge[] = [];
        for (const he of this.halfEdges) {
            if (seen.has(he)) continue;
            result.push(he);
            seen.add(he);
            if (he.twin) seen.add(he.twin);
        }
        return result;
    }

    /**
     * Converts this HalfEdgeMesh back into a THREE.BufferGeometry, rebuilding
     * position/index buffers and recomputing normals. Called after any
     * topology-changing operation (extrude, bevel, loop cut, scale) to
     * refresh what's shown on screen.
     */
    toBufferGeometry(): THREE.BufferGeometry {
        const geometry = new THREE.BufferGeometry();

        const positions = new Float32Array(this.vertices.length * 3);
        for (const v of this.vertices) {
            positions[v.id * 3] = v.position.x;
            positions[v.id * 3 + 1] = v.position.y;
            positions[v.id * 3 + 2] = v.position.z;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        this.triangleIndexToFace = [];
        const indices: number[] = [];
        for (const face of this.faces) {
            const [va, vb, vc] = face.vertices();
            indices.push(va.id, vb.id, vc.id);
            this.triangleIndexToFace.push(face);
        }
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        return geometry;
    }

    /**
     * Groups triangles into visually selectable faces: flood-fills across
     * shared (twin) edges to neighboring triangles whose normal matches
     * within NORMAL_EPSILON, so e.g. a cube face's 2 triangles report as one
     * SelectableFace and clicking either one selects both.
     *
     * Result is cached; call invalidateSelectableFaces() after any topology
     * or vertex-position change before relying on this again (grouping can
     * change — e.g. a bevel introduces a new non-coplanar triangle pair).
     */
    getSelectableFaces(): SelectableFace[] {
        if (this.selectableFacesCache) return this.selectableFacesCache;

        const NORMAL_EPSILON = 1e-4; // dot-product closeness, not angle in degrees
        const visited = new Set<HEFace>();
        const groups: SelectableFace[] = [];

        for (const startFace of this.faces) {
            if (visited.has(startFace)) continue;

            const group: HEFace[] = [];
            const stack: HEFace[] = [startFace];
            const startNormal = startFace.normal();
            visited.add(startFace);

            while (stack.length > 0) {
                const face = stack.pop()!;
                group.push(face);
                face.groupId = groups.length;

                for (const edge of face.edges()) {
                    const twin = edge.twin;
                    if (!twin || visited.has(twin.face)) continue;

                    const neighborNormal = twin.face.normal();
                    // 1 - dot() is ~0 for parallel normals; small for near-parallel.
                    // Using dot directly (not angle) avoids an acos() per edge.
                    if (1 - startNormal.dot(neighborNormal) < NORMAL_EPSILON) {
                        visited.add(twin.face);
                        stack.push(twin.face);
                    }
                }
            }

            groups.push({ id: groups.length, triangles: group });
        }

        this.selectableFacesCache = groups;
        return groups;
    }

    /** Call after any operation that changes topology or vertex positions. */
    invalidateSelectableFaces(): void {
        this.selectableFacesCache = null;
        for (const face of this.faces) {
            face.groupId = undefined;
        }
    }

    /**
     * Validates mesh topology integrity. Run this after every
     * topology-changing operation during development — half-edge bugs
     * (wrong twin assignments, broken next/prev loops) are silent otherwise
     * and only surface as visual corruption much later.
     */
    validate(): MeshValidationResult {
        const errors: string[] = [];

        for (const he of this.halfEdges) {
            // next/prev must be mutually consistent
            if (he.next.prev !== he) {
                errors.push(`HalfEdge ${he.id}: next.prev does not point back to self`);
            }
            if (he.prev.next !== he) {
                errors.push(`HalfEdge ${he.id}: prev.next does not point back to self`);
            }
            // twin must be mutually consistent (if present)
            if (he.twin && he.twin.twin !== he) {
                errors.push(`HalfEdge ${he.id}: twin.twin does not point back to self`);
            }
            // a half-edge and its twin should point to opposite endpoints
            if (he.twin && he.twin.vertex === he.vertex) {
                errors.push(`HalfEdge ${he.id}: twin shares the same destination vertex (degenerate edge)`);
            }
            // face loop must close in exactly 3 steps (triangles only)
            if (he.next.next.next !== he) {
                errors.push(`HalfEdge ${he.id}: face loop does not close after 3 steps`);
            }
            // every half-edge in a face's loop must reference that same face
            if (he.face !== he.next.face) {
                errors.push(`HalfEdge ${he.id}: inconsistent face reference with next edge`);
            }
        }

        for (const v of this.vertices) {
            if (!v.halfEdge) {
                errors.push(`Vertex ${v.id}: has no outgoing/incoming half-edge reference (isolated vertex)`);
            }
        }

        for (const f of this.faces) {
            if (!f.halfEdge) {
                errors.push(`Face ${f.id}: has no half-edge reference`);
            }
        }

        return { valid: errors.length === 0, errors };
    }
}