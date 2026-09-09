import * as THREE from 'three';
import { Viewport } from '../viewport';
import type { SelectionManager } from '../selection/SelectionManager';
import { beginScale, updateScale, commitScale, cancelScale } from './scale';
import type { ScaleHandle, ScaleAxis } from './scale';
import type { InteractionLock } from './InteractionLock';
import type { History } from './History';

/**
 * Blender-style modal scale: press S with a face or edge selected, move
 * away from the pivot to grow or toward it to shrink, X/Y/Z to constrain
 * an axis, left-click/Enter to confirm, right-click/Esc to cancel.
 *
 * Factor is driven by the ratio of current-to-initial screen distance
 * from the pivot, matching Blender's scale-cursor behavior — a different
 * feel from Extrude's fixed-axis delta drag, since scale has a size but
 * no inherent direction.
 */
export class ScaleTool {
    private viewport: Viewport;
    private selectionManager: SelectionManager;
    private lock: InteractionLock;
    private history: History;

    private static readonly LOCK_NAME = 'scale';

    private active = false;
    private handle: ScaleHandle | null = null;
    private axis: ScaleAxis = 'all';
    private currentFactor = 1;

    private pivotScreen = { x: 0, y: 0 };
    private initialDist = 1;
    private hasInitialDist = false;

    /** Floor so a mouse crossing the pivot can't collapse or flip the geometry. */
    private static readonly MIN_FACTOR = 0.01;

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
        if (e.code === 'KeyS' && !this.active) {
            this.start();
            return;
        }
        if (!this.active) return;

        if (e.code === 'Enter') {
            this.confirm();
        } else if (e.code === 'Escape') {
            this.cancel();
        } else if (e.code === 'KeyX') {
            this.setAxis('x');
        } else if (e.code === 'KeyY') {
            this.setAxis('y');
        } else if (e.code === 'KeyZ') {
            this.setAxis('z');
        }
    }

    /** Pressing the already-active axis reverts to unconstrained. */
    private setAxis(axis: ScaleAxis): void {
        if (!this.handle) return;
        this.axis = this.axis === axis ? 'all' : axis;
        updateScale(this.handle, this.currentFactor, this.axis);
        this.refreshVisuals();
    }

    private start(): void {
        const selection = this.selectionManager.current;
        if (!selection) {
            this.notifyStatus('Select a face or edge first, then press S to scale.');
            return;
        }
        if (selection.mode === 'vertex') {
            this.notifyStatus("Can't scale a single vertex — select a face or edge instead.");
            return;
        }

        if (!this.lock.acquire(ScaleTool.LOCK_NAME)) {
            this.notifyStatus('Finish the current operation first.');
            return;
        }

        const vertices = selection.mode === 'face'
            ? Array.from(new Set(selection.selectableFace.triangles.flatMap((t) => t.vertices())))
            : selection.edge.endpoints();

        try {
            this.history.beginAction('Scale');
            this.handle = beginScale(selection.halfEdgeMesh, vertices);
        } catch (err) {
            this.history.discardAction();
            this.notifyStatus(`Can't scale this: ${(err as Error).message}`);
            this.handle = null;
            this.lock.release(ScaleTool.LOCK_NAME);
            return;
        }

        const pivotWorld = selection.mesh.localToWorld(this.handle.center.clone());
        this.pivotScreen = this.worldToScreen(pivotWorld) ?? { x: 0, y: 0 };

        this.axis = 'all';
        this.currentFactor = 1;
        this.hasInitialDist = false;
        this.active = true;
        this.viewport.controls.enabled = false;
    }

    private worldToScreen(worldPos: THREE.Vector3): { x: number; y: number } | null {
        const rect = this.viewport.renderer.domElement.getBoundingClientRect();
        const projected = worldPos.clone().project(this.viewport.camera);
        if (projected.z > 1) return null;
        return {
            x: rect.left + ((projected.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - projected.y) / 2) * rect.height,
        };
    }

    private handlePointerMove(e: PointerEvent): void {
        if (!this.active || !this.handle) return;

        const dist = Math.hypot(e.clientX - this.pivotScreen.x, e.clientY - this.pivotScreen.y);

        if (!this.hasInitialDist) {
            // Floor avoids an oversensitive factor if the mouse starts near the pivot.
            this.initialDist = Math.max(dist, 20);
            this.hasInitialDist = true;
            return;
        }

        const rawFactor = dist / this.initialDist;
        this.currentFactor = Math.max(rawFactor, ScaleTool.MIN_FACTOR);

        updateScale(this.handle, this.currentFactor, this.axis);
        this.refreshVisuals();
    }

    private refreshVisuals(): void {
        const selection = this.selectionManager.current;
        if (!selection) return;
        this.viewport.refreshPrimitive(selection.mesh);
        this.selectionManager.refreshHighlight();
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
        commitScale(this.handle);
        this.history.commitAction();
        this.finish();
    }

    private cancel(): void {
        if (!this.handle) return;
        cancelScale(this.handle);
        this.history.discardAction();
        this.refreshVisuals();
        this.finish();
    }

    private finish(): void {
        this.active = false;
        this.handle = null;
        this.viewport.controls.enabled = true;
        this.lock.release(ScaleTool.LOCK_NAME);
    }
}