import * as THREE from 'three';
import { Viewport } from '../viewport';
import { HalfEdgeMesh } from '../mesh/Halfedgemesh';
import type { History } from '../operations/History';

export interface ParsedObjObject {
    name: string;
    geometry: THREE.BufferGeometry;
}

export interface ObjParseResult {
    objects: ParsedObjObject[];
    /** Faces skipped for referencing an out-of-range vertex or forming a degenerate triangle, rather than silently producing broken geometry. */
    skippedFaceCount: number;
}

/**
 * Parses OBJ text into one BufferGeometry per 'o'/'g' group (or a single
 * group if the file has none). Faces with more than 3 vertices are
 * fan-triangulated from their first vertex — correct for convex
 * polygons (quads from a subdivided box/plane, the common case), not
 * guaranteed correct for non-convex or non-planar n-gons. Texture
 * coordinates and normals in the file are ignored: normals get
 * recomputed on import anyway (HalfEdgeMesh.toBufferGeometry), and this
 * app has no texturing pipeline to use UVs with.
 *
 * OBJ vertex indices are global across the whole file, not reset per
 * group, so each group's local vertex list is built by extracting only
 * the global indices its own faces actually reference.
 */
export function parseObj(text: string): ObjParseResult {
    const allPositions: THREE.Vector3[] = [];
    const objects: ParsedObjObject[] = [];
    let skippedFaceCount = 0;

    let currentName = 'Object1';
    let currentTriangles: [number, number, number][] = [];

    function flushGroup(): void {
        if (currentTriangles.length === 0) return;

        const usedGlobal = new Set<number>();
        for (const tri of currentTriangles) for (const gi of tri) usedGlobal.add(gi);

        const globalToLocal = new Map<number, number>();
        const positions: number[] = [];
        for (const gi of usedGlobal) {
            globalToLocal.set(gi, positions.length / 3);
            const p = allPositions[gi];
            positions.push(p.x, p.y, p.z);
        }

        const indices: number[] = [];
        for (const [a, b, c] of currentTriangles) {
            indices.push(globalToLocal.get(a)!, globalToLocal.get(b)!, globalToLocal.get(c)!);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        objects.push({ name: currentName, geometry });

        currentTriangles = [];
    }

    // Resolves an 'f' token's leading vertex-index part ("5", "5/2", "5/2/1",
    // "5//1") to a 0-based index into allPositions, or null if it's missing,
    // unparseable, or out of range. Negative indices are relative to the end
    // of the vertex list so far, per the OBJ spec.
    function resolveIndex(token: string): number | null {
        const raw = parseInt(token.split('/')[0], 10);
        if (Number.isNaN(raw)) return null;
        const idx = raw < 0 ? allPositions.length + raw : raw - 1;
        return idx >= 0 && idx < allPositions.length ? idx : null;
    }

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        const tag = parts[0];

        if (tag === 'v' && parts.length >= 4) {
            const x = parseFloat(parts[1]);
            const y = parseFloat(parts[2]);
            const z = parseFloat(parts[3]);
            if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
                allPositions.push(new THREE.Vector3(x, y, z));
            }
        } else if (tag === 'o' || tag === 'g') {
            flushGroup();
            currentName = parts.slice(1).join(' ') || currentName;
        } else if (tag === 'f') {
            const refs = parts.slice(1).map(resolveIndex);
            if (refs.length < 3 || refs.some((r) => r === null)) {
                skippedFaceCount++;
                continue;
            }
            const resolved = refs as number[];
            for (let i = 1; i < resolved.length - 1; i++) {
                const a = resolved[0];
                const b = resolved[i];
                const c = resolved[i + 1];
                if (a === b || b === c || a === c) {
                    skippedFaceCount++;
                    continue;
                }
                currentTriangles.push([a, b, c]);
            }
        }
        // vt, vn, mtllib, usemtl, s: intentionally ignored — see doc comment above.
    }
    flushGroup();

    return { objects, skippedFaceCount };
}

/**
 * Opens a file picker for one or more .obj files and adds each parsed
 * object to the scene. Every object is placed at the origin rather than
 * through the Add Primitive grid-spawn logic: buildObjString() already
 * bakes each object's world position into its vertex data on export, so
 * re-applying a position offset here would scatter an already-arranged
 * scene instead of preserving it. All objects from one file-picker
 * action share a single history entry, so one Ctrl+Z undoes the whole
 * batch together.
 */
export function triggerObjImport(viewport: Viewport, history: History, onStatus: (message: string) => void): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.obj';
    input.multiple = true;

    input.addEventListener('change', () => {
        const files = Array.from(input.files ?? []);
        if (files.length === 0) return;

        Promise.all(files.map((f) => f.text())).then((texts) => {
            let totalObjects = 0;
            let totalSkipped = 0;
            let historyStarted = false;

            for (const text of texts) {
                const result = parseObj(text);
                if (result.objects.length === 0) continue;

                if (!historyStarted) {
                    history.beginAction(files.length > 1 ? 'Import OBJ files' : 'Import OBJ');
                    historyStarted = true;
                }

                for (const obj of result.objects) {
                    const halfEdgeMesh = HalfEdgeMesh.fromBufferGeometry(obj.geometry);
                    const validation = halfEdgeMesh.validate();
                    if (!validation.valid) {
                        console.error(`Imported object "${obj.name}" failed validation:`, validation.errors);
                    }
                    viewport.addPrimitive(halfEdgeMesh, 0xffffff, new THREE.Vector3(0, 0, 0));
                }

                totalObjects += result.objects.length;
                totalSkipped += result.skippedFaceCount;
            }

            if (historyStarted) {
                history.commitAction();
            }

            if (totalObjects === 0) {
                onStatus('No valid geometry found in that file.');
            } else if (totalSkipped > 0) {
                onStatus(`Imported ${totalObjects} object(s), skipped ${totalSkipped} malformed face(s).`);
            } else {
                onStatus(`Imported ${totalObjects} object(s).`);
            }
        }).catch((err) => {
            onStatus(`Couldn't read that file: ${(err as Error).message}`);
        });
    });

    input.click();
}
