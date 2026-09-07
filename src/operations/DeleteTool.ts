import { Viewport } from '../viewport';
import type { SelectionManager } from '../selection/SelectionManager';
import { beginDeleteFaces, beginDeleteEdge, beginDeleteVertex, commitDelete, cancelDelete } from './delete';
import type { DeleteHandle } from './delete';
import type { InteractionLock } from './InteractionLock';

/**
 * Delete: select a face, edge, or vertex, press Delete (or Backspace —
 * some laptop keyboards have no dedicated Delete key) to remove it and
 * whatever triangles depend on it (see delete.ts for exactly what each
 * mode removes). No drag phase, same as Loop Cut/Bevel — the removal
 * happens immediately, but still goes through a brief confirm/cancel
 * window for muscle-memory consistency with the other tools and as a
 * safety net against an accidental press.
 */
export class DeleteTool {
    private viewport: Viewport;
    private selectionManager: SelectionManager;
    private lock: InteractionLock;

    private static readonly LOCK_NAME = 'delete';

    private active = false;
    private handle: DeleteHandle | null = null;

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
        window.addEventListener('click', (e) => this.handleClick(e), true);
        window.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
    }

    get isActive(): boolean {
        return this.active;
    }

    private handleKeydown(e: KeyboardEvent): void {
        if ((e.code === 'Delete' || e.code === 'Backspace') && !this.active) {
            e.preventDefault();
            this.start();
            return;
        }
        if (!this.active) return;

        if (e.code === 'Enter') {
            this.confirm();
        } else if (e.code === 'Escape') {
            this.cancel();
        }
    }

    private start(): void {
        const selection = this.selectionManager.current;
        if (!selection) {
            this.notifyStatus('Select a face, edge, or vertex first, then press Delete.');
            return;
        }

        if (!this.lock.acquire(DeleteTool.LOCK_NAME)) {
            this.notifyStatus('Finish the current operation first.');
            return;
        }

        if (selection.mode === 'face') {
            this.handle = beginDeleteFaces(selection.halfEdgeMesh, selection.selectableFace);
        } else if (selection.mode === 'edge') {
            this.handle = beginDeleteEdge(selection.halfEdgeMesh, selection.edge);
        } else {
            this.handle = beginDeleteVertex(selection.halfEdgeMesh, selection.vertex);
        }

        this.viewport.refreshPrimitive(selection.mesh);
        this.selectionManager.clearSelection();
        this.active = true;
        this.viewport.controls.enabled = false;
    }

    private handleClick(e: MouseEvent): void {
        if (!this.active) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        this.confirm();
    }

    private handleContextMenu(e: MouseEvent): void {
        if (!this.active) return;
        e.preventDefault();
        this.cancel();
    }

    private confirm(): void {
        if (!this.handle) return;
        commitDelete(this.handle);
        this.finish();
    }

    private cancel(): void {
        if (!this.handle) return;
        const mesh = this.handle.mesh;
        cancelDelete(this.handle);
        for (const m of this.viewport.getPrimitiveMeshes()) {
            if (this.viewport.getHalfEdgeMesh(m) === mesh) this.viewport.refreshPrimitive(m);
        }
        this.finish();
    }

    private finish(): void {
        this.active = false;
        this.handle = null;
        this.viewport.controls.enabled = true;
        this.lock.release(DeleteTool.LOCK_NAME);
    }
}
