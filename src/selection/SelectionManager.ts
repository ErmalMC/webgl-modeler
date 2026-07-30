import * as THREE from 'three';
import { Viewport } from '../viewport';
import type { SelectableFace, HalfEdgeMesh, HEVertex, HalfEdge } from '../mesh/Halfedgemesh.ts';

export type SelectionMode = 'face' | 'edge' | 'vertex';

export interface FaceSelection {
    mode: 'face';
    mesh: THREE.Mesh;
    halfEdgeMesh: HalfEdgeMesh;
    selectableFace: SelectableFace;
}

export interface EdgeSelection {
    mode: 'edge';
    mesh: THREE.Mesh;
    halfEdgeMesh: HalfEdgeMesh;
    edge: HalfEdge;
}

export interface VertexSelection {
    mode: 'vertex';
    mesh: THREE.Mesh;
    halfEdgeMesh: HalfEdgeMesh;
    vertex: HEVertex;
}

export type Selection = FaceSelection | EdgeSelection | VertexSelection;

const HIGHLIGHT_COLOR = 0xff8800;
const EDGE_PICK_RADIUS_PX = 8;
const VERTEX_PICK_RADIUS_PX = 10;
const VERTEX_DOT_SCREEN_SIZE_PX = 8;

/**
 * Click-based selection (F4 face, plus edge/vertex per Week 8). Three modes,
 * switched via SelectionManager.setMode() — wired to both GUI and numpad
 * keys (1/2/3) by the caller (see ui/gui.ts and main.ts).
 *
 * Face selection raycasts against real mesh triangles (has surface area to
 * hit). Edges and vertices don't, so those two modes instead project
 * candidates to screen space and pick whichever is within a pixel-radius
 * threshold of the click, closest one wins — matching the approach flagged
 * in plan.md's "Known Challenges" section.
 *
 * Helper objects (grid, axes) and meshes added via the lower-level
 * Viewport.addMesh() are not selectable, since they have no HalfEdgeMesh
 * behind them.
 */
export class SelectionManager {
    private viewport: Viewport;
    private raycaster = new THREE.Raycaster();
    private pointer = new THREE.Vector2();
    private highlightObject: THREE.Object3D | null = null;

    // OrbitControls listens on the same canvas; a click-drag to rotate the
    // camera fires 'click' on mouseup too. Track pointer-down position and
    // only treat it as a selection click if the pointer barely moved.
    private pointerDownPos = { x: 0, y: 0 };
    private static readonly CLICK_DRAG_THRESHOLD_PX = 4;

    mode: SelectionMode = 'face';
    current: Selection | null = null;

    // Fired whenever selection changes (selected or cleared), so callers
    // like the GUI can react without polling. Kept as a simple array rather
    // than a full event-emitter dependency for something this small.
    private changeListeners: Array<(selection: Selection | null) => void> = [];
    // Fired whenever the mode changes, independent of selection.
    private modeChangeListeners: Array<(mode: SelectionMode) => void> = [];

    onChange(listener: (selection: Selection | null) => void): void {
        this.changeListeners.push(listener);
    }

    onModeChange(listener: (mode: SelectionMode) => void): void {
        this.modeChangeListeners.push(listener);
    }

    private notifyChange(): void {
        for (const listener of this.changeListeners) listener(this.current);
    }

    private notifyModeChange(): void {
        for (const listener of this.modeChangeListeners) listener(this.mode);
    }

    constructor(viewport: Viewport) {
        this.viewport = viewport;
        const canvas = viewport.renderer.domElement;
        canvas.addEventListener('pointerdown', (e) => {
            this.pointerDownPos = { x: e.clientX, y: e.clientY };
        });
        canvas.addEventListener('click', (e) => {
            const dx = e.clientX - this.pointerDownPos.x;
            const dy = e.clientY - this.pointerDownPos.y;
            if (Math.hypot(dx, dy) > SelectionManager.CLICK_DRAG_THRESHOLD_PX) return;
            this.handleClick(e);
        });

        // Top-row 1/2/3 for selection mode — matches Blender's actual
        // convention. Numpad 1/2/3 are reserved for camera views (see
        // Viewport.handleKeydown) so these must not collide with those.
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Digit1') this.setMode('face');
            else if (e.code === 'Digit2') this.setMode('edge');
            else if (e.code === 'Digit3') this.setMode('vertex');
        });
    }

    /**
     * Switches selection mode. Following Blender's convention, this clears
     * the current selection rather than trying to convert it (e.g. a
     * selected face doesn't become "its 4 vertices" automatically) — keeps
     * behavior predictable and avoids ambiguous multi-target conversions.
     */
    setMode(mode: SelectionMode): void {
        if (this.mode === mode) return;
        this.mode = mode;
        this.clearSelection();
        this.notifyModeChange();
    }

    private handleClick(event: MouseEvent): void {
        const rect = this.viewport.renderer.domElement.getBoundingClientRect();
        const clickX = event.clientX - rect.left;
        const clickY = event.clientY - rect.top;
        this.pointer.x = (clickX / rect.width) * 2 - 1;
        this.pointer.y = -(clickY / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.pointer, this.viewport.camera);

        const selectableMeshes = this.viewport.getPrimitiveMeshes();
        const hits = this.raycaster.intersectObjects(selectableMeshes, false);

        if (hits.length === 0) {
            this.clearSelection();
            return;
        }

        const hit = hits[0];
        const mesh = hit.object as THREE.Mesh;
        const halfEdgeMesh = this.viewport.getHalfEdgeMesh(mesh);
        if (!halfEdgeMesh) {
            this.clearSelection();
            return;
        }

        if (this.mode === 'face') {
            this.handleFaceClick(mesh, halfEdgeMesh, hit);
        } else if (this.mode === 'vertex') {
            this.handleVertexClick(mesh, halfEdgeMesh, rect, clickX, clickY);
        } else {
            this.handleEdgeClick(mesh, halfEdgeMesh, rect, clickX, clickY);
        }
    }

    private handleFaceClick(mesh: THREE.Mesh, halfEdgeMesh: HalfEdgeMesh, hit: THREE.Intersection): void {
        // hit.faceIndex is null for non-indexed/point/line objects; our
        // primitives are always indexed triangle meshes, but guard anyway
        // rather than assume.
        if (hit.faceIndex === null || hit.faceIndex === undefined) {
            this.clearSelection();
            return;
        }

        const triangleFace = halfEdgeMesh.getFaceByTriangleIndex(hit.faceIndex);
        if (!triangleFace || triangleFace.groupId === undefined) {
            // groupId is undefined if getSelectableFaces() hasn't been called
            // yet for this mesh (e.g. right after an operation that invalidated
            // the cache) — compute it now rather than silently failing to select.
            halfEdgeMesh.getSelectableFaces();
        }
        const refreshedFace = halfEdgeMesh.getFaceByTriangleIndex(hit.faceIndex)!;
        const group = halfEdgeMesh.getSelectableFaces()[refreshedFace.groupId!];

        this.select({ mode: 'face', mesh, halfEdgeMesh, selectableFace: group });
    }

    /**
     * Projects every vertex of the mesh to screen space and picks the
     * closest one within VERTEX_PICK_RADIUS_PX of the click. O(vertexCount)
     * per click — fine at this project's scale (a UV sphere is under 1000
     * vertices); would need a spatial index if meshes grew much larger.
     */
    private handleVertexClick(
        mesh: THREE.Mesh,
        halfEdgeMesh: HalfEdgeMesh,
        rect: DOMRect,
        clickX: number,
        clickY: number
    ): void {
        let closest: HEVertex | null = null;
        let closestDist = VERTEX_PICK_RADIUS_PX;

        const worldPos = new THREE.Vector3();
        for (const v of halfEdgeMesh.vertices) {
            worldPos.copy(v.position).applyMatrix4(mesh.matrixWorld);
            const screen = this.worldToScreen(worldPos, rect);
            if (!screen) continue; // behind the camera

            const dist = Math.hypot(screen.x - clickX, screen.y - clickY);
            if (dist < closestDist) {
                closestDist = dist;
                closest = v;
            }
        }

        if (closest) {
            this.select({ mode: 'vertex', mesh, halfEdgeMesh, vertex: closest });
        } else {
            this.clearSelection();
        }
    }

    /**
     * Projects every unique edge's two endpoints to screen space and picks
     * the closest one (by point-to-segment distance) within
     * EDGE_PICK_RADIUS_PX of the click. Uses getUniqueEdges() so each
     * physical edge is only tested once, not once per triangle side.
     */
    private handleEdgeClick(
        mesh: THREE.Mesh,
        halfEdgeMesh: HalfEdgeMesh,
        rect: DOMRect,
        clickX: number,
        clickY: number
    ): void {
        let closest: HalfEdge | null = null;
        let closestDist = EDGE_PICK_RADIUS_PX;

        const worldA = new THREE.Vector3();
        const worldB = new THREE.Vector3();
        for (const edge of halfEdgeMesh.getUniqueEdges()) {
            const [a, b] = edge.endpoints();
            worldA.copy(a.position).applyMatrix4(mesh.matrixWorld);
            worldB.copy(b.position).applyMatrix4(mesh.matrixWorld);
            const screenA = this.worldToScreen(worldA, rect);
            const screenB = this.worldToScreen(worldB, rect);
            if (!screenA || !screenB) continue;

            const dist = pointToSegmentDistance(clickX, clickY, screenA.x, screenA.y, screenB.x, screenB.y);
            if (dist < closestDist) {
                closestDist = dist;
                closest = edge;
            }
        }

        if (closest) {
            this.select({ mode: 'edge', mesh, halfEdgeMesh, edge: closest });
        } else {
            this.clearSelection();
        }
    }

    /** Projects a world-space point to canvas pixel coordinates. Returns null if behind the camera. */
    private worldToScreen(worldPos: THREE.Vector3, rect: DOMRect): { x: number; y: number } | null {
        const projected = worldPos.clone().project(this.viewport.camera);
        if (projected.z > 1) return null; // behind the camera / clipped
        return {
            x: ((projected.x + 1) / 2) * rect.width,
            y: ((1 - projected.y) / 2) * rect.height,
        };
    }

    select(selection: Selection): void {
        this.current = selection;
        this.rebuildHighlight();
        this.notifyChange();
    }

    clearSelection(): void {
        if (this.current === null) return; // avoid firing spurious no-op change events
        this.current = null;
        this.removeHighlight();
        this.notifyChange();
    }

    /** Call after any operation changes the selected mesh's geometry, to keep the overlay in sync. */
    refreshHighlight(): void {
        this.rebuildHighlight();
    }

    private rebuildHighlight(): void {
        this.removeHighlight();
        if (!this.current) return;

        if (this.current.mode === 'face') {
            this.highlightObject = this.buildFaceHighlight(this.current);
        } else if (this.current.mode === 'edge') {
            this.highlightObject = this.buildEdgeHighlight(this.current);
        } else {
            this.highlightObject = this.buildVertexHighlight(this.current);
        }

        // Parent under the selected mesh rather than manually copying its
        // transform: highlight geometry/points are already expressed in the
        // mesh's local space (straight from HEVertex.position), so parenting
        // lets Three.js's scene graph keep the highlight correctly positioned
        // if the mesh is ever moved, rotated, or scaled — no manual sync needed.
        this.current.mesh.add(this.highlightObject);
    }

    private buildFaceHighlight(selection: FaceSelection): THREE.Mesh {
        const positions: number[] = [];
        for (const tri of selection.selectableFace.triangles) {
            const [va, vb, vc] = tri.vertices();
            positions.push(
                va.position.x, va.position.y, va.position.z,
                vb.position.x, vb.position.y, vb.position.z,
                vc.position.x, vc.position.y, vc.position.z,
            );
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeVertexNormals();

        const material = new THREE.MeshBasicMaterial({
            color: HIGHLIGHT_COLOR,
            // Slightly offset via polygon offset rather than scaling the overlay,
            // so highlight geometry doesn't visually separate from the base mesh
            // at grazing camera angles.
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.6,
        });
        return new THREE.Mesh(geometry, material);
    }

    private buildEdgeHighlight(selection: EdgeSelection): THREE.Line {
        const [a, b] = selection.edge.endpoints();
        const geometry = new THREE.BufferGeometry().setFromPoints([a.position, b.position]);
        const material = new THREE.LineBasicMaterial({
            color: HIGHLIGHT_COLOR,
            linewidth: 3, // note: WebGL ignores linewidth on most platforms; kept for the few that honor it
        });
        return new THREE.Line(geometry, material);
    }

    private buildVertexHighlight(selection: VertexSelection): THREE.Sprite {
        // A camera-facing sprite renders as a consistent on-screen dot size
        // regardless of distance, which reads more clearly as "a point" than
        // a 3D sphere would at oblique angles or far zoom. sizeAttenuation:false
        // keeps it a fixed pixel size; scale is set in normalized device units,
        // recalculated on resize would be needed for perfect precision but a
        // fixed value is a reasonable approximation at typical window sizes.
        const material = new THREE.SpriteMaterial({ color: HIGHLIGHT_COLOR, sizeAttenuation: false });
        const sprite = new THREE.Sprite(material);
        const scale = (VERTEX_DOT_SCREEN_SIZE_PX / window.innerHeight) * 2;
        sprite.scale.set(scale, scale, 1);
        // Local-space position — correct once parented under the mesh in
        // rebuildHighlight(), since HEVertex.position is already mesh-local.
        sprite.position.copy(selection.vertex.position);
        return sprite;
    }

    private removeHighlight(): void {
        if (!this.highlightObject) return;
        this.highlightObject.parent?.remove(this.highlightObject);
        const obj = this.highlightObject as THREE.Mesh | THREE.Line | THREE.Sprite;
        obj.geometry?.dispose?.();
        const material = obj.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) {
            material.forEach((m) => m.dispose());
        } else {
            material?.dispose?.();
        }
        this.highlightObject = null;
    }
}

/** Shortest distance from point (px,py) to line segment (ax,ay)-(bx,by), all in the same 2D space. */
function pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - ax, py - ay); // degenerate segment (a === b)

    let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = ax + t * dx;
    const closestY = ay + t * dy;
    return Math.hypot(px - closestX, py - closestY);
}