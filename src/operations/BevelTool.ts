import { Viewport } from '../viewport';
import type { SelectionManager } from '../selection/SelectionManager';
import { beginBevel, commitBevel, cancelBevel } from './bevel';
import type { BevelHandle } from './bevel';
import type { InteractionLock } from './InteractionLock';
import type { History } from './History';
import { NumericEntry } from './NumericEntry';

/**
 * Bevel: select an edge, press Ctrl+B to start. Like Loop Cut, there's no
 * "distance 0" phase — a zero-width bevel is degenerate geometry, not a
 * smaller bevel — so it's inserted at a default width immediately. Unlike
 * Loop Cut, width is worth adjusting live, so this tool re-runs the whole
 * operation from scratch on every mouse move rather than repositioning
 * vertices directly — bevel.ts's geometry doesn't change with width, only
 * positions do, so re-deriving is cheap and guarantees the live result
 * goes through the same verified code path as the initial cut.
 *
 * Width can also be typed directly (press a digit while dragging) via
 * NumericEntry, instead of dragging the mouse to an exact value by eye.
 */
export class BevelTool {
    private viewport: Viewport;
    private selectionManager: SelectionManager;
    private lock: InteractionLock;
    private history: History;
    private numericEntry = new NumericEntry();

    private static readonly LOCK_NAME = 'bevel';
    private static readonly DEFAULT_WIDTH = 0.2;
    private static readonly MIN_WIDTH = 0.01;

    private active = false;
    private handle: BevelHandle | null = null;
    private currentWidth = BevelTool.DEFAULT_WIDTH;

    // Kept directly rather than read back off selectionManager, since
    // selection is cleared as soon as the bevel starts.
    private edge: Parameters<typeof beginBevel>[1] | null = null;
    private meshRef: Parameters<typeof beginBevel>[0] | null = null;

    private lastPointer = { x: 0, y: 0 };
    private hasBaseline = false;

    private static readonly PIXELS_PER_UNIT = 100;

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
        window.addEventListener('pointermove', (e) => this.handlePointerMove(e));
        window.addEventListener('click', (e) => this.handleClick(e), true);
        window.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
    }

    get isActive(): boolean {
        return this.active;
    }

    private handleKeydown(e: KeyboardEvent): void {
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyB' && !this.active) {
            e.preventDefault();
            this.start();
            return;
        }
        if (!this.active) return;

        if (this.numericEntry.handleKey(e)) {
            this.applyNumericWidth();
            return;
        }

        if (e.code === 'Enter') {
            this.confirm();
        } else if (e.code === 'Escape') {
            this.cancel();
        }
    }

    private start(): void {
        const selection = this.selectionManager.current;
        if (!selection || selection.mode !== 'edge') {
            this.notifyStatus('Select an edge (key 2) first, then Ctrl+B to bevel.');
            return;
        }

        if (!this.lock.acquire(BevelTool.LOCK_NAME)) {
            this.notifyStatus('Finish the current operation first.');
            return;
        }

        this.edge = selection.edge;
        this.meshRef = selection.halfEdgeMesh;
        this.currentWidth = BevelTool.DEFAULT_WIDTH;

        try {
            this.history.beginAction('Bevel');
            this.handle = beginBevel(this.meshRef, this.edge, this.currentWidth);
        } catch (err) {
            this.history.discardAction();
            this.notifyStatus(`Can't bevel this: ${(err as Error).message}`);
            this.handle = null;
            this.edge = null;
            this.meshRef = null;
            this.lock.release(BevelTool.LOCK_NAME);
            return;
        }

        this.viewport.refreshPrimitive(selection.mesh);
        this.selectionManager.clearSelection();
        this.hasBaseline = false;
        this.numericEntry.reset();
        this.active = true;
        this.viewport.controls.enabled = false;
    }

    /** Re-derives the bevel from scratch at `width` — shared by mouse drag and numeric entry. */
    private applyWidth(width: number): void {
        if (!this.handle || !this.edge || !this.meshRef) return;
        this.currentWidth = width;
        cancelBevel(this.handle);
        this.handle = beginBevel(this.meshRef, this.edge, this.currentWidth);
        for (const m of this.viewport.getPrimitiveMeshes()) {
            if (this.viewport.getHalfEdgeMesh(m) === this.meshRef) this.viewport.refreshPrimitive(m);
        }
    }

    private applyNumericWidth(): void {
        const value = this.numericEntry.value;
        if (value === null) return; // incomplete entry (e.g. just "-") — nothing to apply yet
        this.applyWidth(Math.max(value, BevelTool.MIN_WIDTH));
        this.notifyStatus(`Width: ${this.numericEntry.displayText}`);
    }

    private handlePointerMove(e: PointerEvent): void {
        if (!this.active || !this.handle || !this.edge || !this.meshRef) return;
        if (this.numericEntry.active) return;

        if (!this.hasBaseline) {
            this.lastPointer = { x: e.clientX, y: e.clientY };
            this.hasBaseline = true;
            return;
        }

        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };

        // Overall mouse motion, not a projected axis — a bevel's width has no direction.
        const delta = (dx + -dy) / BevelTool.PIXELS_PER_UNIT;
        this.applyWidth(Math.max(this.currentWidth + delta, BevelTool.MIN_WIDTH));
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
        commitBevel(this.handle);
        this.history.commitAction();
        this.finish();
    }

    private cancel(): void {
        if (!this.handle || !this.meshRef) return;
        const mesh = this.meshRef;
        cancelBevel(this.handle);
        this.history.discardAction();
        for (const m of this.viewport.getPrimitiveMeshes()) {
            if (this.viewport.getHalfEdgeMesh(m) === mesh) this.viewport.refreshPrimitive(m);
        }
        this.finish();
    }

    private finish(): void {
        this.active = false;
        this.handle = null;
        this.edge = null;
        this.meshRef = null;
        this.numericEntry.reset();
        this.viewport.controls.enabled = true;
        this.lock.release(BevelTool.LOCK_NAME);
    }
}