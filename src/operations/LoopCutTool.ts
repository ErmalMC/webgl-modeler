import { Viewport } from '../viewport';
import type { SelectionManager } from '../selection/SelectionManager';
import { beginLoopCut, commitLoopCut, cancelLoopCut } from './loopCut';
import type { LoopCutHandle } from './loopCut';
import type { InteractionLock } from './InteractionLock';
import type { History } from './History';

/**
 * Loop Cut: select an edge, press Ctrl+R to cut. No drag phase — the ring
 * is inserted immediately at the midpoint of every crossed edge, since a
 * loop cut has no natural "distance 0" to grow from. Still goes through a
 * brief confirm/cancel window, matching Blender's own flow and the other
 * three tools' muscle memory.
 */
export class LoopCutTool {
    private viewport: Viewport;
    private selectionManager: SelectionManager;
    private lock: InteractionLock;
    private history: History;

    private static readonly LOCK_NAME = 'loopCut';

    private active = false;
    private handle: LoopCutHandle | null = null;

    private statusListeners: Array<(message: string) => void> = [];

    onStatus(listener: (message: string) => void): void {
        this.statusListeners.push(listener);
    }

    private notifyStatus(message: string): void {
        for (const listener of this.statusListeners) listener(message);
    }

    constructor(viewport: Viewport, selectionManager: SelectionManager, lock: InteractionLock, history: History) {
        this.viewport = viewport;
        this.selectionManager = selectionManager;
        this.lock = lock;
        this.history = history;

        window.addEventListener('keydown', (e) => this.handleKeydown(e));
        window.addEventListener('click', (e) => this.handleClick(e), true);
        window.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
    }

    get isActive(): boolean {
        return this.active;
    }

    private handleKeydown(e: KeyboardEvent): void {
        // Modifier required or plain R would fight the browser's reload shortcut.
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyR' && !this.active) {
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
        if (!selection || selection.mode !== 'edge') {
            this.notifyStatus('Select an edge (key 2) first, then Ctrl+R to loop cut.');
            return;
        }

        if (!this.lock.acquire(LoopCutTool.LOCK_NAME)) {
            this.notifyStatus('Finish the current operation first.');
            return;
        }

        try {
            this.history.beginAction('Loop Cut');
            this.handle = beginLoopCut(selection.halfEdgeMesh, selection.edge);
        } catch (err) {
            this.history.discardAction();
            this.notifyStatus(`Can't loop cut here: ${(err as Error).message}`);
            this.handle = null;
            this.lock.release(LoopCutTool.LOCK_NAME);
            return;
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
        commitLoopCut(this.handle);
        this.history.commitAction();
        this.finish();
    }

    private cancel(): void {
        if (!this.handle) return;
        const mesh = this.handle.mesh;
        cancelLoopCut(this.handle);
        this.history.discardAction();
        for (const m of this.viewport.getPrimitiveMeshes()) {
            if (this.viewport.getHalfEdgeMesh(m) === mesh) this.viewport.refreshPrimitive(m);
        }
        this.finish();
    }

    private finish(): void {
        this.active = false;
        this.handle = null;
        this.viewport.controls.enabled = true;
        this.lock.release(LoopCutTool.LOCK_NAME);
    }
}