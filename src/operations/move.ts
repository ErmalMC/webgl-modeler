import * as THREE from 'three';

/**
 * Handle to an in-progress whole-object move. Unlike Extrude/Scale/Bevel/
 * Loop Cut, this never touches the mesh's HalfEdgeMesh — it only
 * repositions the THREE.Mesh's own transform, so the mesh's topology and
 * any current face/edge/vertex selection stay valid the whole time.
 */
export interface MoveHandle {
    mesh: THREE.Mesh;
    basePosition: THREE.Vector3;
}

export function beginMove(mesh: THREE.Mesh): MoveHandle {
    return { mesh, basePosition: mesh.position.clone() };
}

/** Repositions the mesh to basePosition + offset, recomputed from the base each call so drift can't accumulate. */
export function updateMoveOffset(handle: MoveHandle, offset: THREE.Vector3): void {
    handle.mesh.position.copy(handle.basePosition).add(offset);
}

/** No-op — updateMoveOffset() already applied the final position. */
export function commitMove(_handle: MoveHandle): void {
    // Intentionally empty.
}

/** Restores the mesh to its pre-move position. */
export function cancelMove(handle: MoveHandle): void {
    handle.mesh.position.copy(handle.basePosition);
}
