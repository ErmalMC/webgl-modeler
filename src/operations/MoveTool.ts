import * as THREE from 'three';
import { Viewport } from '../viewport';
import type { SelectionManager } from '../selection/SelectionManager';
import { beginMove, updateMoveOffset, commitMove, cancelMove } from './move';
import type { MoveHandle } from './move';
import type { InteractionLock } from './InteractionLock';
import type { History } from './History';
import { NumericEntry } from './NumericEntry';

type MoveAxis = 'all' | 'x' | 'y' | 'z';

/**
 * Move (G): translates a whole object rather than any of its topology.
 * There's no separate "select an object" mode in this app, so this reuses
 * whatever face/edge/vertex is currently selected purely to identify
 * which mesh to move — select any part of an object, press G, drag
 * freely in the camera's view plane, optionally press X/Y/Z to constrain
 * to one axis (press again to release), left-click/Enter to confirm,
 * right-click/Esc to cancel.
 *
 * Once an axis is constrained, that axis's offset can also be typed
 * directly via NumericEntry — the free 2-axis drag has no single scalar
 * to type, so numeric entry only engages after X/Y/Z locks it to one.
 *
 * Never calls refreshPrimitive() or touches the HalfEdgeMesh — moving a
 * rigid object only changes its THREE.Mesh position, so the selection
 * highlight (parented under the mesh, see SelectionManager) tags along
 * automatically via the scene graph, and the current selection stays
 * exactly as valid after a move as before it.
 */
export class MoveTool {
    private viewport: Viewport;
    private selectionManager: SelectionManager;
    private lock: InteractionLock;
    private history: History;
    private numericEntry = new NumericEntry();

    private static readonly LOCK_NAME = 'move';
    private static readonly PIXELS_PER_UNIT = 100;

    private active = false;
    private handle: MoveHandle | null = null;
    private axis: MoveAxis = 'all';

    /** Accumulated world-space offset from the pre-move position — recomputed base-relative each call like Scale/Extrude. */
    private offset = new THREE.Vector3();

    // Free-drag (axis 'all'): camera's view-plane axes, captured once since
    // OrbitControls is disabled for the whole drag.
    private viewRight = new THREE.Vector3(1, 0, 0);
    private viewUp = new THREE.Vector3(0, 1, 0);

    // Axis-constrained drag: the screen-space direction that world axis
    // projects to, recomputed whenever the constraint changes.
    private axisScreenDir = new THREE.Vector2(1, 0);

    private lastPointer = { x: 0, y: 0 };
    private hasBaseline = false;

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
        if (e.code === 'KeyG' && !this.active) {
            this.start();
            return;
        }
        if (!this.active) return;

        if (this.axis !== 'all' && this.numericEntry.handleKey(e)) {
            this.applyNumericOffset();
            return;
        }

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

    private start(): void {
        const selection = this.selectionManager.current;
        if (!selection) {
            this.notifyStatus('Select any part of an object first, then press G to move it.');
            return;
        }

        if (!this.lock.acquire(MoveTool.LOCK_NAME)) {
            this.notifyStatus('Finish the current operation first.');
            return;
        }

        this.handle = beginMove(selection.mesh);
        this.history.beginAction('Move');
        this.offset.set(0, 0, 0);
        this.axis = 'all';

        const camera = this.viewport.camera;
        this.viewRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        this.viewUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

        this.hasBaseline = false;
        this.numericEntry.reset();
        this.active = true;
        this.viewport.controls.enabled = false;
    }

    /** Pressing the already-active axis reverts to unconstrained, mirroring ScaleTool's X/Y/Z toggle. */
    private setAxis(axis: MoveAxis): void {
        if (!this.handle) return;
        const next: MoveAxis = this.axis === axis ? 'all' : axis;
        this.axis = next;
        this.numericEntry.reset(); // a new axis starts a fresh typed value, not a carried-over one

        if (next !== 'all') {
            // Snap to just this axis's current component, matching Blender's
            // G-then-X: the other two reset to 0 rather than staying at
            // whatever the free drag had left them at.
            const kept = next === 'x' ? this.offset.x : next === 'y' ? this.offset.y : this.offset.z;
            this.offset.set(0, 0, 0);
            if (next === 'x') this.offset.x = kept;
            else if (next === 'y') this.offset.y = kept;
            else this.offset.z = kept;

            this.axisScreenDir = this.computeAxisScreenDirection(next);
        }

        updateMoveOffset(this.handle, this.offset);
    }

    /** Projects a unit vector along `axis` from the mesh's current position into screen space. */
    private computeAxisScreenDirection(axis: 'x' | 'y' | 'z'): THREE.Vector2 {
        const mesh = this.handle!.mesh;
        const origin = mesh.position.clone();
        const axisVec = axis === 'x' ? new THREE.Vector3(1, 0, 0)
            : axis === 'y' ? new THREE.Vector3(0, 1, 0)
                : new THREE.Vector3(0, 0, 1);
        const tip = origin.clone().addScaledVector(axisVec, 0.5);

        const originNDC = origin.clone().project(this.viewport.camera);
        const tipNDC = tip.clone().project(this.viewport.camera);

        const dir = new THREE.Vector2(tipNDC.x - originNDC.x, -(tipNDC.y - originNDC.y));
        return dir.lengthSq() > 1e-8 ? dir.normalize() : new THREE.Vector2(1, 0);
    }

    /** Sets the current axis's offset to an absolute typed value (not a relative delta, matching mouse-drag's own behavior once an axis is locked). */
    private applyNumericOffset(): void {
        if (!this.handle || this.axis === 'all') return;
        const value = this.numericEntry.value;
        if (value === null) return; // incomplete entry (e.g. just "-") — nothing to apply yet

        if (this.axis === 'x') this.offset.x = value;
        else if (this.axis === 'y') this.offset.y = value;
        else this.offset.z = value;

        updateMoveOffset(this.handle, this.offset);
        this.notifyStatus(`${this.axis.toUpperCase()}: ${this.numericEntry.displayText}`);
    }

    private handlePointerMove(e: PointerEvent): void {
        if (!this.active || !this.handle) return;
        if (this.numericEntry.active) return;

        if (!this.hasBaseline) {
            this.lastPointer = { x: e.clientX, y: e.clientY };
            this.hasBaseline = true;
            return;
        }

        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };

        if (this.axis === 'all') {
            this.offset
                .addScaledVector(this.viewRight, dx / MoveTool.PIXELS_PER_UNIT)
                .addScaledVector(this.viewUp, -dy / MoveTool.PIXELS_PER_UNIT);
        } else {
            const delta = (dx * this.axisScreenDir.x + dy * this.axisScreenDir.y) / MoveTool.PIXELS_PER_UNIT;
            if (this.axis === 'x') this.offset.x += delta;
            else if (this.axis === 'y') this.offset.y += delta;
            else this.offset.z += delta;
        }

        updateMoveOffset(this.handle, this.offset);
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
        commitMove(this.handle);
        this.history.commitAction();
        this.finish();
    }

    private cancel(): void {
        if (!this.handle) return;
        cancelMove(this.handle);
        this.history.discardAction();
        this.finish();
    }

    private finish(): void {
        this.active = false;
        this.handle = null;
        this.axis = 'all';
        this.numericEntry.reset();
        this.viewport.controls.enabled = true;
        this.lock.release(MoveTool.LOCK_NAME);
    }
}