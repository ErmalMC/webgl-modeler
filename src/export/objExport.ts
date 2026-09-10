import * as THREE from 'three';

/**
 * Builds a Wavefront OBJ text representation of the given meshes, one
 * 'o' group per mesh so re-importing elsewhere keeps them as distinct
 * objects. Positions and normals are baked into world space via each
 * mesh's matrixWorld, since OBJ has no per-object transform of its own.
 */
export function buildObjString(meshes: THREE.Mesh[]): string {
    const lines: string[] = ['# Exported from WebGL Modeler'];

    let indexOffset = 0; // OBJ indices are 1-based and shared across the whole file
    let objectIndex = 0;
    const worldPos = new THREE.Vector3();
    const worldNormal = new THREE.Vector3();

    for (const mesh of meshes) {
        const geometry = mesh.geometry;
        const posAttr = geometry.getAttribute('position');
        const normalAttr = geometry.getAttribute('normal');
        const index = geometry.getIndex();
        if (!posAttr || !index) continue;

        mesh.updateMatrixWorld();
        objectIndex++;
        lines.push(`o Object${objectIndex}`);

        for (let i = 0; i < posAttr.count; i++) {
            worldPos.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
            lines.push(`v ${worldPos.x.toFixed(6)} ${worldPos.y.toFixed(6)} ${worldPos.z.toFixed(6)}`);
        }

        if (normalAttr) {
            // computeVertexNormals() (called in HalfEdgeMesh.toBufferGeometry())
            // always produces one normal per position, same index order —
            // safe to reuse the same a/b/c indices for both.
            for (let i = 0; i < normalAttr.count; i++) {
                worldNormal.fromBufferAttribute(normalAttr, i).transformDirection(mesh.matrixWorld);
                lines.push(`vn ${worldNormal.x.toFixed(6)} ${worldNormal.y.toFixed(6)} ${worldNormal.z.toFixed(6)}`);
            }
        }

        for (let t = 0; t < index.count; t += 3) {
            const a = index.getX(t) + indexOffset + 1;
            const b = index.getX(t + 1) + indexOffset + 1;
            const c = index.getX(t + 2) + indexOffset + 1;
            lines.push(normalAttr ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
        }

        indexOffset += posAttr.count;
    }

    return lines.join('\n') + '\n';
}

/** Triggers a browser download of buildObjString(meshes) as a .obj file. */
export function downloadObj(meshes: THREE.Mesh[], filename: string = 'model.obj'): void {
    const text = buildObjString(meshes);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}