import * as THREE from 'three';
import { Viewport } from '../viewport';
import type { SelectionManager } from '../selection/SelectionManager';
import { beginFaceExtrude, beginVertexExtrude, beginTipExtrude, updateExtrudeDistance, updateExtrudeOffset, commitExtrude, cancelExtrude } from './extrude';
import type { ExtrudeHandle } from './extrude';

/**
 * Blender-style modal extrude: press E with a face selected to start,
 * move the mouse to drag the face along its normal, left-click or Enter
 * to confirm, right-click or Esc to cancel.
 *
 * "Modal" here means: while dragging, this tool temporarily owns pointer
 * movement and disables OrbitControls (otherwise dragging to extrude
 * would also spin the camera), and intercepts the next click so it
 * confirms the extrude instead of falling through to SelectionManager's
 * normal click-to-select handling.
 */
export class ExtrudeTool {
    private viewport: Viewport;
    private selectionManager: SelectionManager;

    private active = false;
    private handle: ExtrudeHandle | null = null;
    private currentDistance = 0;

    // Which kind of drag is in progress, decided in start(): 'face' slides
    // along a single fixed axis (the face normal — there's only one sane
    // push direction for a face); 'vertex' moves freely in the camera's
    // view plane (matches Blender's default, unconstrained translate after
    // extruding a lone vertex — a new "spike" has no single correct
    // direction the way a face does).
    private dragMode: 'face' | 'vertex' | null = null;

    // --- 'face' mode state ---
    // Screen-space direction the face's normal projects to; mouse-delta is
    // measured along this so dragging "outward" feels correct regardless of
    // camera angle.
    private screenDir = new THREE.Vector2(1, 0);

    // --- 'vertex' mode state ---
    // The camera's right/up axes in world space, captured once at drag
    // start (safe to cache: OrbitControls is disabled for the whole drag,
    // see start(), so the camera can't move mid-drag). Mouse movement is
    // mapped onto these two axes to slide the tip freely within the plane
    // facing the camera.
    private viewRight = new THREE.Vector3(1, 0, 0);
    private viewUp = new THREE.Vector3(0, 1, 0);
    private currentOffset = new THREE.Vector3();

    // Pointer position as of the last processed move, used to compute
    // deltas. Set fresh at the start of each drag rather than carried over
    // from whatever the pointer was doing before E was pressed.
    private lastPointer = { x: 0, y: 0 };
    private hasBaseline = false;

    /** Pixels of mouse movement per 1 unit of extrude distance. */
    private static readonly PIXELS_PER_UNIT = 100;

    // Fired with a short human-readable reason whenever extrude can't
    // start, so the GUI can show it on-screen rather than only in the
    // browser console (which most users never have open).
    private statusListeners: Array<(message: string) => void> = [];

    onStatus(listener: (message: string) => void): void {
        this.statusListeners.push(listener);
    }

    private notifyStatus(message: string): void {
        for (const listener of this.statusListeners) listener(message);
    }

    constructor(viewport: Viewport, selectionManager: SelectionManager) {
        this.viewport = viewport;
        this.selectionManager = selectionManager;

        window.addEventListener('keydown', (e) => this.handleKeydown(e));
        window.addEventListener('pointermove', (e) => this.handlePointerMove(e));
        // Capture phase so this runs before SelectionManager's own click
        // listener, letting us swallow the confirm-click before it's treated
        // as a new selection attempt.
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

        try {
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
                return;
            }
        } catch (err) {
            // Legitimate cases this can throw: extruding a vertex that's on a
            // mesh boundary with no whisker to extend (e.g. a plane's corners),
            // or a face selection whose boundary isn't a single closed loop.
            // These are real, expected limitations, not bugs — fail quietly
            // rather than crash the whole tool, but still tell the person why.
            this.notifyStatus(`Can't extrude this: ${(err as Error).message}`);
            this.handle = null;
            return;
        }

        this.currentDistance = 0;
        this.hasBaseline = false;
        this.active = true;

        // Suppress camera orbit while dragging.
        this.viewport.controls.enabled = false;
    }

    /**
     * A vertex is extrudable two different ways depending on its current
     * shape: a normal interior mesh vertex (closed ring — see
     * HalfEdgeMesh.getVertexRing) uses beginVertexExtrude(), while the tip
     * of an EXISTING whisker (produced by a prior vertex/tip extrude) has a
     * different shape entirely and needs beginTipExtrude() instead. Try the
     * common case first; fall back to the tip case; let a genuine failure
     * (neither shape — e.g. a boundary vertex on an open mesh like
     * PlaneGeometry's corners) propagate to the caller's own catch.
     */
    private beginVertexOrTipExtrude(halfEdgeMesh: Parameters<typeof beginVertexExtrude>[0], vertex: Parameters<typeof beginVertexExtrude>[1]): ExtrudeHandle {
        try {
            return beginVertexExtrude(halfEdgeMesh, vertex);
        } catch {
            return beginTipExtrude(halfEdgeMesh, vertex);
        }
    }

    /** Centroid of a set of mesh-local points. */
    private faceGroupCenter(points: { position: THREE.Vector3 }[]): THREE.Vector3 {
        const center = new THREE.Vector3();
        for (const p of points) center.add(p.position);
        return center.divideScalar(points.length);
    }

    /**
     * Returns the active camera's right/up axes in world space, for
     * mapping mouse movement onto the plane facing the camera during a
     * free (vertex-extrude) drag. Works for either camera type since both
     * are THREE.Object3D and expose a world-space quaternion.
     */
    private computeViewPlaneAxes(): { right: THREE.Vector3; up: THREE.Vector3 } {
        const camera = this.viewport.camera;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        return { right, up };
    }

    /**
     * Projects a direction into screen space: takes a local-space center
     * point and center+normal in world space, projects both to NDC, and
     * returns the resulting 2D direction (Y flipped to match screen pixel
     * coordinates, where +Y is down).
     */
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
            // First move after pressing E just establishes a baseline position —
            // don't jump the extrude distance based on wherever the mouse
            // happened to already be.
            this.lastPointer = { x: e.clientX, y: e.clientY };
            this.hasBaseline = true;
            return;
        }

        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };

        const selection = this.selectionManager.current;
        if (!selection || (selection.mode !== 'face' && selection.mode !== 'vertex')) return; // shouldn't happen mid-drag, but guard anyway

        if (this.dragMode === 'face') {
            const delta = (dx * this.screenDir.x + dy * this.screenDir.y) / ExtrudeTool.PIXELS_PER_UNIT;
            this.currentDistance += delta;
            updateExtrudeDistance(this.handle, this.currentDistance);
        } else {
            // Free drag: screen-right/down maps onto the camera's world-space
            // right/up axes. Screen Y grows downward while `viewUp` should
            // feel like "up", so dy is negated.
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
        this.finish();
    }

    private cancel(): void {
        if (!this.handle) return;
        cancelExtrude(this.handle);
        const selection = this.selectionManager.current;
        if (selection && (selection.mode === 'face' || selection.mode === 'vertex')) {
            this.viewport.refreshPrimitive(selection.mesh);
        }
        // The pre-extrude selection may no longer resolve to the same
        // reference after cancel (coplanar grouping can shift, or the ring
        // vertex's local state has changed); clearing is the safe choice.
        this.selectionManager.clearSelection();
        this.finish();
    }

    private finish(): void {
        this.active = false;
        this.handle = null;
        this.dragMode = null;
        this.viewport.controls.enabled = true;
    }
}