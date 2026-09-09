import * as THREE from 'three';
import { Viewport } from '../viewport';
import type { SelectionManager } from '../selection/SelectionManager';
import { beginFaceExtrude, beginVertexExtrude, beginTipExtrude, updateExtrudeDistance, updateExtrudeOffset, commitExtrude, cancelExtrude } from './extrude';
import type { ExtrudeHandle } from './extrude';
import type { InteractionLock } from './InteractionLock';
import type { History } from './History';

/**
 * Blender-style modal extrude: press E with a face or vertex selected,
 * move the mouse to drag, left-click/Enter to confirm, right-click/Esc
 * to cancel. While active this owns pointer movement, disables
 * OrbitControls, and intercepts the confirm click.
 */
export class ExtrudeTool {
    private viewport: Viewport;
    private selectionManager: SelectionManager;
    private lock: InteractionLock;
    private history: History;

    private static readonly LOCK_NAME = 'extrude';

    private active = false;
    private handle: ExtrudeHandle | null = null;
    private currentDistance = 0;

    // 'face' slides along the fixed normal; 'vertex' moves freely in the
    // camera's view plane (a new spike has no single correct direction).
    private dragMode: 'face' | 'vertex' | null = null;

    // --- 'face' mode state ---
    private screenDir = new THREE.Vector2(1, 0);

    // --- 'vertex' mode state ---
    private viewRight = new THREE.Vector3(1, 0, 0);
    private viewUp = new THREE.Vector3(0, 1, 0);
    private currentOffset = new THREE.Vector3();

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
        // Capture phase so this runs before SelectionManager's click listener,
        // letting the confirm-click get swallowed before it's treated as a new selection.
        window.addEventListener('click', (e) => this.handleClick(e), true);
        window.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
    }

    get isActive(): boolean {
        return this.active;
    }

    private handleKeydown(e: KeyboardEvent): void {
        if (e.code === 'KeyE' && !this.active) {
            this.start();
        } else if (this.active && e.code === 'Enter') {
            this.confirm();
        } else if (this.active && e.code === 'Escape') {
            this.cancel();
        }
    }

    private start(): void {
        const selection = this.selectionManager.current;
        if (!selection) {
            this.notifyStatus('Select a face or vertex first, then press E to extrude.');
            return;
        }

        if (!this.lock.acquire(ExtrudeTool.LOCK_NAME)) {
            this.notifyStatus('Finish the current operation first.');
            return;
        }

        try {
            this.history.beginAction(selection.mode === 'face' ? 'Extrude Face' : 'Extrude Vertex');
            if (selection.mode === 'face') {
                this.handle = beginFaceExtrude(selection.halfEdgeMesh, selection.selectableFace);
                const localCenter = this.faceGroupCenter(selection.selectableFace.triangles.flatMap((t) => t.vertices()));
                this.screenDir = this.computeScreenDirection(selection.mesh, localCenter, this.handle.normal);
                this.dragMode = 'face';
            } else if (selection.mode === 'vertex') {
                this.handle = this.beginVertexOrTipExtrude(selection.halfEdgeMesh, selection.vertex);
                const axes = this.computeViewPlaneAxes();
                this.viewRight = axes.right;
                this.viewUp = axes.up;
                this.currentOffset.set(0, 0, 0);
                this.dragMode = 'vertex';
            } else {
                this.notifyStatus('Edge extrude is not implemented yet.');
                this.history.discardAction();
                this.lock.release(ExtrudeTool.LOCK_NAME);
                return;
            }
        } catch (err) {
            this.history.discardAction();
            this.notifyStatus(`Can't extrude this: ${(err as Error).message}`);
            this.handle = null;
            this.lock.release(ExtrudeTool.LOCK_NAME);
            return;
        }

        this.currentDistance = 0;
        this.hasBaseline = false;
        this.active = true;
        this.viewport.controls.enabled = false;
    }

    /** Tries the common interior-vertex case first, falls back to tip-extrude for an existing whisker's tip. */
    private beginVertexOrTipExtrude(halfEdgeMesh: Parameters<typeof beginVertexExtrude>[0], vertex: Parameters<typeof beginVertexExtrude>[1]): ExtrudeHandle {
        try {
            return beginVertexExtrude(halfEdgeMesh, vertex);
        } catch {
            return beginTipExtrude(halfEdgeMesh, vertex);
        }
    }

    private faceGroupCenter(points: { position: THREE.Vector3 }[]): THREE.Vector3 {
        const center = new THREE.Vector3();
        for (const p of points) center.add(p.position);
        return center.divideScalar(points.length);
    }

    private computeViewPlaneAxes(): { right: THREE.Vector3; up: THREE.Vector3 } {
        const camera = this.viewport.camera;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        return { right, up };
    }

    private computeScreenDirection(
        mesh: THREE.Mesh,
        localCenter: THREE.Vector3,
        normal: THREE.Vector3
    ): THREE.Vector2 {
        const worldCenter = mesh.localToWorld(localCenter.clone());
        const worldTip = mesh.localToWorld(localCenter.clone().addScaledVector(normal, 0.5));

        const centerNDC = worldCenter.clone().project(this.viewport.camera);
        const tipNDC = worldTip.clone().project(this.viewport.camera);

        const dir = new THREE.Vector2(tipNDC.x - centerNDC.x, -(tipNDC.y - centerNDC.y));
        return dir.lengthSq() > 1e-8 ? dir.normalize() : new THREE.Vector2(1, 0);
    }

    private handlePointerMove(e: PointerEvent): void {
        if (!this.active || !this.handle) return;

        if (!this.hasBaseline) {
            this.lastPointer = { x: e.clientX, y: e.clientY };
            this.hasBaseline = true;
            return;
        }

        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };

        const selection = this.selectionManager.current;
        if (!selection || (selection.mode !== 'face' && selection.mode !== 'vertex')) return;

        if (this.dragMode === 'face') {
            const delta = (dx * this.screenDir.x + dy * this.screenDir.y) / ExtrudeTool.PIXELS_PER_UNIT;
            this.currentDistance += delta;
            updateExtrudeDistance(this.handle, this.currentDistance);
        } else {
            this.currentOffset
                .addScaledVector(this.viewRight, dx / ExtrudeTool.PIXELS_PER_UNIT)
                .addScaledVector(this.viewUp, -dy / ExtrudeTool.PIXELS_PER_UNIT);
            updateExtrudeOffset(this.handle, this.currentOffset);
        }

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
        commitExtrude(this.handle);
        this.history.commitAction();
        this.finish();
    }

    private cancel(): void {
        if (!this.handle) return;
        cancelExtrude(this.handle);
        this.history.discardAction();
        const selection = this.selectionManager.current;
        if (selection && (selection.mode === 'face' || selection.mode === 'vertex')) {
            this.viewport.refreshPrimitive(selection.mesh);
        }
        // Selection may no longer resolve the same way after cancel (coplanar
        // grouping can shift), so clearing is the safe choice.
        this.selectionManager.clearSelection();
        this.finish();
    }

    private finish(): void {
        this.active = false;
        this.handle = null;
        this.dragMode = null;
        this.viewport.controls.enabled = true;
        this.lock.release(ExtrudeTool.LOCK_NAME);
    }
}