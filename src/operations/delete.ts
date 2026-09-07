import { HalfEdgeMesh, HEVertex, HEFace, HalfEdge } from '../mesh/Halfedgemesh.ts';
import type { SelectableFace } from '../mesh/Halfedgemesh.ts';

/**
 * Delete: removes a face, edge, or vertex selection and whatever
 * triangles depend on it. Every half-edge must belong to a triangle (see
 * Halfedgemesh.ts), so there's no "delete a face but leave its edges"
 * the way Blender's Delete Faces does on an n-gon mesh — removing a
 * triangle always removes its 3 half-edges with it, and any vertex left
 * with no surviving half-edge (fully surrounded by what was just
 * deleted) is removed too, since an isolated vertex fails validate().
 */

export interface DeleteHandle {
    mesh: HalfEdgeMesh;
    removedFaces: HEFace[];
    removedHalfEdges: HalfEdge[];
    /** Vertices left with no surviving half-edge after the faces above were removed. */
    removedVertices: HEVertex[];
    /** Each outside neighbor half-edge that had its twin nulled out, mapped to the removed edge it used to point to. */
    neighborTwinBackup: Map<HalfEdge, HalfEdge>;
    /** Each surviving vertex's .halfEdge before it was repointed away from a removed edge. */
    vertexHalfEdgeBackup: Map<HEVertex, HalfEdge | null>;
}

/** Removes every triangle in a SelectableFace group — e.g. both triangles of a cube face. */
export function beginDeleteFaces(mesh: HalfEdgeMesh, group: SelectableFace): DeleteHandle {
    return removeFaces(mesh, group.triangles);
}

/**
 * Removes the 1–2 raw triangles adjacent to `edge`, matching Blender's
 * own "Delete Edges" (faces using the edge are deleted with it). If
 * `edge` is the internal diagonal of a coplanar group (e.g. a cube
 * face's 2 triangles), this removes the whole visual face; if it's a
 * boundary between two different groups, it only removes one triangle
 * from each, leaving an irregular hole — an accurate reflection of the
 * mesh's actual triangulation, not a bug.
 */
export function beginDeleteEdge(mesh: HalfEdgeMesh, edge: HalfEdge): DeleteHandle {
    const faces = edge.twin ? [edge.face, edge.twin.face] : [edge.face];
    return removeFaces(mesh, faces);
}

/** Removes every triangle touching `vertex`, matching Blender's "Delete Vertices". */
export function beginDeleteVertex(mesh: HalfEdgeMesh, vertex: HEVertex): DeleteHandle {
    const faces = mesh.faces.filter((f) => f.vertices().includes(vertex));
    return removeFaces(mesh, faces);
}

/** No-op — removeFaces() already committed the topology change. */
export function commitDelete(_handle: DeleteHandle): void {
    // Intentionally empty.
}

/** Restores every removed face, half-edge, and vertex, and reverses every twin/halfEdge redirect. */
export function cancelDelete(handle: DeleteHandle): void {
    const { mesh, removedFaces, removedHalfEdges, removedVertices, neighborTwinBackup, vertexHalfEdgeBackup } = handle;

    for (const [neighborEdge, originalEdge] of neighborTwinBackup) {
        neighborEdge.twin = originalEdge;
    }
    for (const [v, originalHalfEdge] of vertexHalfEdgeBackup) {
        v.halfEdge = originalHalfEdge;
    }

    mesh.faces = mesh.faces.concat(removedFaces);
    mesh.halfEdges = mesh.halfEdges.concat(removedHalfEdges);
    mesh.vertices = mesh.vertices.concat(removedVertices);

    mesh.invalidateSelectableFaces();
}

/**
 * Shared core: removes `facesToRemove` and their half-edges, nulls out
 * any outside neighbor's twin that pointed into the removed set (so it
 * correctly becomes a boundary edge), and removes any vertex left with
 * no surviving half-edge. O(touchedVertices * mesh.halfEdges.length) —
 * fine at this project's scale, same reasoning as SelectionManager's own
 * click-hit-testing.
 */
function removeFaces(mesh: HalfEdgeMesh, facesToRemove: HEFace[]): DeleteHandle {
    const removedFaceSet = new Set(facesToRemove);
    const removedHalfEdges = facesToRemove.flatMap((f) => f.edges());
    const removedHalfEdgeSet = new Set(removedHalfEdges);

    const neighborTwinBackup = new Map<HalfEdge, HalfEdge>();
    for (const he of removedHalfEdges) {
        if (he.twin && !removedHalfEdgeSet.has(he.twin)) {
            neighborTwinBackup.set(he.twin, he);
            he.twin.twin = null;
        }
    }

    const touchedVertices = new Set<HEVertex>();
    for (const f of facesToRemove) {
        for (const v of f.vertices()) touchedVertices.add(v);
    }

    const vertexHalfEdgeBackup = new Map<HEVertex, HalfEdge | null>();
    const removedVertices: HEVertex[] = [];
    for (const v of touchedVertices) {
        const survivingEdge = mesh.halfEdges.find((he) => !removedHalfEdgeSet.has(he) && he.vertex === v);
        if (survivingEdge) {
            if (!v.halfEdge || removedHalfEdgeSet.has(v.halfEdge)) {
                vertexHalfEdgeBackup.set(v, v.halfEdge);
                v.halfEdge = survivingEdge;
            }
        } else {
            removedVertices.push(v);
        }
    }
    const removedVertexSet = new Set(removedVertices);

    mesh.faces = mesh.faces.filter((f) => !removedFaceSet.has(f));
    mesh.halfEdges = mesh.halfEdges.filter((he) => !removedHalfEdgeSet.has(he));
    mesh.vertices = mesh.vertices.filter((v) => !removedVertexSet.has(v));

    mesh.invalidateSelectableFaces();

    return {
        mesh,
        removedFaces: facesToRemove,
        removedHalfEdges,
        removedVertices,
        neighborTwinBackup,
        vertexHalfEdgeBackup,
    };
}
