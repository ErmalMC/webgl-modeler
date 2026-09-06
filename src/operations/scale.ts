import * as THREE from 'three';
import type { HalfEdgeMesh, HEVertex } from '../mesh/Halfedgemesh.ts';

/**
 * Scale/Stretch: resizes a set of vertices around their shared centroid,
 * uniformly or along a single axis. Never changes topology — only
 * repositions the vertices already in the selection, so a scaled face's
 * shared corners naturally drag neighboring faces along with them.
 *
 * Works uniformly across selection modes since beginScale() only needs a
 * flat vertex list, not a SelectableFace/HalfEdge-specific type.
 */

export type ScaleAxis = 'all' | 'x' | 'y' | 'z';

export interface ScaleHandle {
    mesh: HalfEdgeMesh;
    vertices: HEVertex[];
    /** Pre-scale position per vertex — factors always apply from here, never from the current position, so repeated updates don't compound rounding error. */
    basePositions: Map<HEVertex, THREE.Vector3>;
    /** Fixed pivot every vertex scales around — the centroid at distance-1, computed once. */
    center: THREE.Vector3;
}

/** Requires at least 2 distinct vertices — a single point has no size to change. */
export function beginScale(mesh: HalfEdgeMesh, vertices: HEVertex[]): ScaleHandle {
    const distinct = Array.from(new Set(vertices));
    if (distinct.length < 2) {
        throw new Error('beginScale: need at least 2 distinct vertices to scale (a single point has no size).');
    }

    const center = new THREE.Vector3();
    for (const v of distinct) center.add(v.position);
    center.divideScalar(distinct.length);

    const basePositions = new Map<HEVertex, THREE.Vector3>();
    for (const v of distinct) basePositions.set(v, v.position.clone());

    return { mesh, vertices: distinct, basePositions, center };
}

/**
 * Repositions every vertex to `center + (basePosition - center) * factor`,
 * recomputed from the distance-1 base each call. `axis` restricts the
 * scale to a single world axis, leaving the other two untouched.
 */
export function updateScale(handle: ScaleHandle, factor: number, axis: ScaleAxis = 'all'): void {
    for (const v of handle.vertices) {
        const base = handle.basePositions.get(v)!;
        const offset = base.clone().sub(handle.center);
        switch (axis) {
            case 'x':
                offset.x *= factor;
                break;
            case 'y':
                offset.y *= factor;
                break;
            case 'z':
                offset.z *= factor;
                break;
            default:
                offset.multiplyScalar(factor);
        }
        v.position.copy(handle.center).add(offset);
    }
}

/**
 * A non-uniform axis-constrained scale can break a face's triangles out
 * of coplanar alignment, so the cached SelectableFace groupings need
 * invalidating even though no topology changed.
 */
export function commitScale(handle: ScaleHandle): void {
    handle.mesh.invalidateSelectableFaces();
}

/** Restores every vertex to its pre-scale position. No topology was touched. */
export function cancelScale(handle: ScaleHandle): void {
    for (const v of handle.vertices) {
        const base = handle.basePositions.get(v);
        if (base) v.position.copy(base);
    }
}
