import * as THREE from 'three';

/**
 * Half-edge mesh over triangulated geometry — every Face is a single
 * triangle. A "cube face" is therefore two HalfEdgeMesh triangles sharing
 * a diagonal; grouping coplanar triangles into one selectable face is
 * SelectionManager's job, not this structure's.
 */

export class HEVertex {
    id: number;
    position: THREE.Vector3;
    /** One half-edge that points TO this vertex — enough to walk the full ring. */
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

    get origin(): HEVertex {
        return this.prev.vertex;
    }

    endpoints(): [HEVertex, HEVertex] {
        return [this.origin, this.vertex];
    }
}

export class HEFace {
    id: number;
    /** Any one half-edge on this face's loop. */
    halfEdge!: HalfEdge;

    /** SelectableFace group id — undefined/stale until getSelectableFaces() runs. */
    groupId: number | undefined = undefined;

    constructor(id: number) {
        this.id = id;
    }

    edges(): [HalfEdge, HalfEdge, HalfEdge] {
        const e0 = this.halfEdge;
        const e1 = e0.next;
        const e2 = e1.next;
        return [e0, e1, e2];
    }

    vertices(): [HEVertex, HEVertex, HEVertex] {
        const [e0, e1, e2] = this.edges();
        return [e0.vertex, e1.vertex, e2.vertex];
    }

    normal(): THREE.Vector3 {
        const [va, vb, vc] = this.vertices();
        const edgeAB = new THREE.Vector3().subVectors(vb.position, va.position);
        const edgeAC = new THREE.Vector3().subVectors(vc.position, va.position);
        return new THREE.Vector3().crossVectors(edgeAB, edgeAC).normalize();
    }
}

/** A visually selectable face: one or more coplanar triangles sharing edges. */
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

    private selectableFacesCache: SelectableFace[] | null = null;

    /**
     * Three.js primitives duplicate vertices at UV/normal seams (e.g.
     * BoxGeometry: 24 buffer vertices for 8 corners), so buffer index isn't
     * a reliable stand-in for "same physical point." This merges buffer
     * vertices sharing a position before building half-edges.
     */
    static fromBufferGeometry(geometry: THREE.BufferGeometry): HalfEdgeMesh {
        const mesh = new HalfEdgeMesh();

        const posAttr = geometry.getAttribute('position');
        const index = geometry.getIndex();
        if (!index) {
            throw new Error('HalfEdgeMesh.fromBufferGeometry requires indexed geometry.');
        }

        const POSITION_EPSILON = 1e-5;
        const quantize = (n: number) => Math.round(n / POSITION_EPSILON);
        const posKey = (v: THREE.Vector3) => `${quantize(v.x)}_${quantize(v.y)}_${quantize(v.z)}`;

        const vertexByPos = new Map<string, HEVertex>();
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

        // Track edges by (fromId, toId) so twins resolve in a second pass
        // instead of an O(n^2) search.
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

            if (!vb.halfEdge) vb.halfEdge = heAB;
            if (!vc.halfEdge) vc.halfEdge = heBC;
            if (!va.halfEdge) va.halfEdge = heCA;

            edgeMap.set(key(va.id, vb.id), heAB);
            edgeMap.set(key(vb.id, vc.id), heBC);
            edgeMap.set(key(vc.id, va.id), heCA);

            mesh.faces.push(face);
        }

        // twin of (a->b) is (b->a), if it exists; no twin means boundary edge
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

    /** Rebuilt by toBufferGeometry(); maps a raycast faceIndex back to its HEFace. */
    private triangleIndexToFace: HEFace[] = [];

    getFaceByTriangleIndex(triangleIndex: number): HEFace | undefined {
        return this.triangleIndexToFace[triangleIndex];
    }

    /** One HalfEdge per physical edge (skips the twin of any edge already returned). */
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
     * shared edges to neighbors with a matching normal. Cached — call
     * invalidateSelectableFaces() after any topology/position change.
     */
    getSelectableFaces(): SelectableFace[] {
        if (this.selectableFacesCache) return this.selectableFacesCache;

        const NORMAL_EPSILON = 1e-4; // dot-product closeness, not degrees
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

    invalidateSelectableFaces(): void {
        this.selectableFacesCache = null;
        for (const face of this.faces) {
            face.groupId = undefined;
        }
    }

    /**
     * Ordered outer boundary loop of a SelectableFace group — an internal
     * diagonal (both sides inside the group) is excluded. Needed so a
     * multi-triangle face (e.g. a cube face) extrudes as one quad rather
     * than two independent triangles.
     */
    getBoundaryLoop(group: SelectableFace): HalfEdge[] {
        const groupTriangles = new Set(group.triangles);
        const boundaryEdges: HalfEdge[] = [];

        for (const face of group.triangles) {
            for (const edge of face.edges()) {
                const isInternal = edge.twin !== null && groupTriangles.has(edge.twin.face);
                if (!isInternal) boundaryEdges.push(edge);
            }
        }

        const byOrigin = new Map<HEVertex, HalfEdge>();
        for (const e of boundaryEdges) {
            byOrigin.set(e.origin, e);
        }

        const loop: HalfEdge[] = [];
        const start = boundaryEdges[0];
        let current: HalfEdge | undefined = start;
        const visited = new Set<HalfEdge>();

        while (current && !visited.has(current)) {
            loop.push(current);
            visited.add(current);
            current = byOrigin.get(current.vertex);
        }

        if (loop.length !== boundaryEdges.length || current !== start) {
            throw new Error(
                `getBoundaryLoop: boundary of face group ${group.id} is not a single ` +
                `closed loop (found ${loop.length} of ${boundaryEdges.length} edges in sequence).`
            );
        }

        return loop;
    }

    /**
     * Outgoing half-edges from `vertex`, ordered by walking the triangle
     * fan via `current.next.next.twin`. Throws if the ring doesn't close
     * (vertex is on a mesh boundary) — vertex extrude only supports
     * interior vertices.
     */
    getVertexRing(vertex: HEVertex): HalfEdge[] {
        if (!vertex.halfEdge) {
            throw new Error(`getVertexRing: vertex ${vertex.id} has no half-edge reference (isolated vertex)`);
        }

        // vertex.halfEdge is an INCOMING edge; its twin is the outgoing spoke to start from.
        const incoming = vertex.halfEdge;
        if (!incoming.twin) {
            throw new Error(
                `getVertexRing: vertex ${vertex.id} is on a mesh boundary; boundary-vertex extrude is not supported.`
            );
        }
        const start = incoming.twin;

        const ring: HalfEdge[] = [];
        let current: HalfEdge | undefined = start;
        const visited = new Set<HalfEdge>();

        while (current && !visited.has(current)) {
            ring.push(current);
            visited.add(current);
            const intoVertex: HalfEdge = current.next.next;
            if (intoVertex.vertex !== vertex) {
                throw new Error(
                    `getVertexRing: internal invariant violated for vertex ${vertex.id} — ` +
                    `triangle loop does not return to the starting vertex after 3 steps.`
                );
            }
            current = intoVertex.twin ?? undefined;
        }

        if (current !== start || ring.length === 0) {
            throw new Error(
                `getVertexRing: vertex ${vertex.id}'s ring did not close; boundary-vertex extrude is not supported.`
            );
        }

        return ring;
    }

    /** Run after any topology-changing operation — half-edge bugs are silent otherwise. */
    validate(): MeshValidationResult {
        const errors: string[] = [];

        for (const he of this.halfEdges) {
            if (he.next.prev !== he) {
                errors.push(`HalfEdge ${he.id}: next.prev does not point back to self`);
            }
            if (he.prev.next !== he) {
                errors.push(`HalfEdge ${he.id}: prev.next does not point back to self`);
            }
            if (he.twin && he.twin.twin !== he) {
                errors.push(`HalfEdge ${he.id}: twin.twin does not point back to self`);
            }
            if (he.twin && he.twin.vertex === he.vertex) {
                errors.push(`HalfEdge ${he.id}: twin shares the same destination vertex (degenerate edge)`);
            }
            if (he.next.next.next !== he) {
                errors.push(`HalfEdge ${he.id}: face loop does not close after 3 steps`);
            }
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
