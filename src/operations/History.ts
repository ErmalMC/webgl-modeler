import * as THREE from 'three';
import { Viewport } from '../viewport';
import type { SelectionManager } from '../selection/SelectionManager';
import { HalfEdgeMesh } from '../mesh/Halfedgemesh';
import type { InteractionLock } from './InteractionLock';

/**
 * Undo/redo across every persistent scene change: Move, Delete, Extrude,
 * Scale, Loop Cut, Bevel, Add Primitive, Clear Scene. One shared stack,
 * not per-tool.
 *
 * Rather than giving every operation module its own "redo" function,
 * this snapshots the whole scene as plain position/index data and
 * restores by wiping and rebuilding via
 * HalfEdgeMesh.fromBufferGeometryExact() (the no-merge import variant —
 * see Halfedgemesh.ts for why merging would corrupt a distance-0
 * extrude). No object identity is reused across a snapshot, so
 * out-of-order or compounding operations can't corrupt anything.
 *
 * Selection is cleared on every undo/redo, same as any topology change.
 */

interface MeshSnapshot {
    position: THREE.Vector3;
    positions: Float32Array;
    indices: number[];
}

interface SceneSnapshot {
    meshes: MeshSnapshot[];
}

interface HistoryEntry {
    label: string;
    snapshot: SceneSnapshot;
}

export class History {
    private viewport: Viewport;
    private selectionManager: SelectionManager;
    private lock: InteractionLock;

    private static readonly MAX_ENTRIES = 100;

    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];

    /** Set by beginAction(), resolved by commitAction()/discardAction(). */
    private pending: HistoryEntry | null = null;

    private statusListeners: Array<(message: string) => void> = [];

    onStatus(listener: (message: string) => void): void {
        this.statusListeners.push(listener);
    }

    private notifyStatus(message: string): void {
        for (const listener of this.statusListeners) listener(message);
    }

    constructor(viewport: Viewport, selectionManager: SelectionManager, lock: InteractionLock) {
        this.viewport = viewport;
        this.selectionManager = selectionManager;
        this.lock = lock;

        window.addEventListener('keydown', (e) => this.handleKeydown(e));
    }

    private handleKeydown(e: KeyboardEvent): void {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.code === 'KeyZ' && e.shiftKey) {
            e.preventDefault();
            this.redo();
        } else if (e.code === 'KeyZ') {
            e.preventDefault();
            this.undo();
        } else if (e.code === 'KeyY') {
            e.preventDefault();
            this.redo();
        }
    }

    /** Call right before a mutation begins — captures the "before" state. */
    beginAction(label: string): void {
        this.pending = { label, snapshot: this.captureSnapshot() };
    }

    /** Call once the action is confirmed. Clears the redo stack, since a new action invalidates it. */
    commitAction(): void {
        if (!this.pending) return;
        this.undoStack.push(this.pending);
        if (this.undoStack.length > History.MAX_ENTRIES) this.undoStack.shift();
        this.redoStack = [];
        this.pending = null;
    }

    /** Discards without recording — nothing persisted. */
    discardAction(): void {
        this.pending = null;
    }

    undo(): void {
        if (this.lock.isLocked()) {
            this.notifyStatus('Finish the current operation first.');
            return;
        }
        const entry = this.undoStack.pop();
        if (!entry) {
            this.notifyStatus('Nothing to undo.');
            return;
        }
        this.redoStack.push({ label: entry.label, snapshot: this.captureSnapshot() });
        this.applySnapshot(entry.snapshot);
        this.notifyStatus(`Undid: ${entry.label}`);
    }

    redo(): void {
        if (this.lock.isLocked()) {
            this.notifyStatus('Finish the current operation first.');
            return;
        }
        const entry = this.redoStack.pop();
        if (!entry) {
            this.notifyStatus('Nothing to redo.');
            return;
        }
        this.undoStack.push({ label: entry.label, snapshot: this.captureSnapshot() });
        this.applySnapshot(entry.snapshot);
        this.notifyStatus(`Redid: ${entry.label}`);
    }

    /** mesh.geometry is kept in sync by refreshPrimitive(), so it's read directly rather than re-derived. */
    private captureSnapshot(): SceneSnapshot {
        const meshes: MeshSnapshot[] = [];
        for (const mesh of this.viewport.getPrimitiveMeshes()) {
            const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
            const index = mesh.geometry.getIndex();
            if (!posAttr) continue;
            meshes.push({
                position: mesh.position.clone(),
                positions: new Float32Array(posAttr.array as ArrayLike<number>),
                indices: index ? Array.from(index.array as ArrayLike<number>) : [],
            });
        }
        return { meshes };
    }

    /** Wipes every primitive and rebuilds the scene from a snapshot. */
    private applySnapshot(snapshot: SceneSnapshot): void {
        this.selectionManager.clearSelection();
        this.viewport.clearMeshes();
        for (const m of snapshot.meshes) {
            const geometry = new THREE.BufferGeometry();
            // .slice() so re-applying this entry later can't hand out a live array.
            geometry.setAttribute('position', new THREE.BufferAttribute(m.positions.slice(), 3));
            geometry.setIndex(m.indices.slice());
            const halfEdgeMesh = HalfEdgeMesh.fromBufferGeometryExact(geometry);
            this.viewport.addPrimitive(halfEdgeMesh, 0xffffff, m.position.clone());
        }
    }
}
