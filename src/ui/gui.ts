import { Pane } from 'tweakpane';
import * as THREE from 'three';
import { Viewport } from '../viewport.ts';
import type { ViewPreset } from '../viewport.ts';
import { createPrimitive } from '../mesh/MeshBuilder.ts';
import { HalfEdgeMesh } from '../mesh/Halfedgemesh.ts';
import type { SelectionManager } from '../selection/SelectionManager.ts';
import type { ExtrudeTool } from '../operations/ExtrudeTool.ts';

const SPAWN_SPACING = 2.5;
const SPAWN_PER_ROW = 5;

export function setupGUI(viewport: Viewport, selectionManager: SelectionManager, extrudeTool: ExtrudeTool) {
    const pane = new Pane({ title: 'WebGL Modeler' });
    // Tweakpane's default width (~200px) clips longer button labels and
    // folder titles. Widen it and pin it clear of the viewport edge.
    pane.element.style.width = '280px';
    pane.element.style.position = 'fixed';
    pane.element.style.top = '12px';
    pane.element.style.right = '12px';
    pane.element.style.maxHeight = 'calc(100vh - 24px)';
    pane.element.style.overflowY = 'auto';

    // --- Camera section -------------------------------------------------
    const cameraFolder = pane.addFolder({ title: 'Camera' });

    // Tweakpane 4 monitors bindings, not raw values, so we wrap the active
    // camera's constructor name behind a plain object the pane can observe.
    const cameraState = { type: viewport.camera.type };
    const cameraMonitor = cameraFolder.addBinding(cameraState, 'type', {
        label: 'Mode',
        readonly: true,
    });

    cameraFolder.addButton({ title: 'Toggle Ortho/Persp (5)' })
        .on('click', () => {
            viewport.toggleCameraType();
            cameraState.type = viewport.camera.type;
            cameraMonitor.refresh();
        });

    const viewButtons: { title: string; preset: ViewPreset }[] = [
        { title: 'Front (1)', preset: 'front' },
        { title: 'Back (2)', preset: 'back' },
        { title: 'Right (3)', preset: 'right' },
        { title: 'Left (4)', preset: 'left' },
        { title: 'Top (7)', preset: 'top' },
        { title: 'Bottom (9)', preset: 'bottom' },
    ];
    for (const { title, preset } of viewButtons) {
        cameraFolder.addButton({ title }).on('click', () => {
            viewport.setView(preset);
            cameraState.type = viewport.camera.type;
            cameraMonitor.refresh();
        });
    }

    // Numpad shortcuts change the camera outside the pane's knowledge, so
    // keep the monitor honest by polling on every render-adjacent frame
    // via a lightweight interval (cheap: it's a single string compare).
    setInterval(() => {
        if (cameraState.type !== viewport.camera.type) {
            cameraState.type = viewport.camera.type;
            cameraMonitor.refresh();
        }
    }, 200);

    // --- Primitives section ----------------------------------------------
    const primitivesFolder = pane.addFolder({ title: 'Primitives' });
    const primitiveParams = { type: 'box' as 'box' | 'plane' | 'cylinder' | 'sphere', size: 1 };

    primitivesFolder.addBinding(primitiveParams, 'type', {
        label: 'Shape',
        options: {
            Cube: 'box',
            Plane: 'plane',
            Cylinder: 'cylinder',
            Sphere: 'sphere',
        },
    });

    primitivesFolder.addBinding(primitiveParams, 'size', {
        label: 'Size',
        min: 0.1,
        max: 5,
        step: 0.1,
    });

    let spawnCount = 0;
    primitivesFolder.addButton({ title: 'Add Primitive' }).on('click', () => {
        const geometry = createPrimitive(primitiveParams.type, primitiveParams.size);
        const halfEdgeMesh = HalfEdgeMesh.fromBufferGeometry(geometry);

        // Validate on spawn during development — half-edge bugs are silent
        // otherwise and only show up as visual corruption once an operation
        // (extrude/bevel/loop cut) runs on a broken mesh.
        const result = halfEdgeMesh.validate();
        if (!result.valid) {
            console.error(`HalfEdgeMesh validation failed for new ${primitiveParams.type}:`, result.errors);
        }

        const col = spawnCount % SPAWN_PER_ROW;
        const row = Math.floor(spawnCount / SPAWN_PER_ROW);
        const position = new THREE.Vector3(col * SPAWN_SPACING, 0, row * SPAWN_SPACING);
        viewport.addPrimitive(halfEdgeMesh, 0xffffff, position);
        spawnCount++;
    });

    primitivesFolder.addButton({ title: 'Clear Scene' }).on('click', () => {
        viewport.clearMeshes();
        spawnCount = 0;
        selectionManager.clearSelection();
    });

    // --- Selection section --------------------------------------------------
    const selectionFolder = pane.addFolder({ title: 'Selection' });

    const modeState = { mode: selectionManager.mode as 'face' | 'edge' | 'vertex' };
    const modeMonitor = selectionFolder.addBinding(modeState, 'mode', {
        label: 'Mode',
        readonly: true,
    });

    const modeButtons: { title: string; mode: 'face' | 'edge' | 'vertex' }[] = [
        { title: 'Face (Key 1)', mode: 'face' },
        { title: 'Edge (Key 2)', mode: 'edge' },
        { title: 'Vertex (Key 3)', mode: 'vertex' },
    ];
    for (const { title, mode } of modeButtons) {
        selectionFolder.addButton({ title }).on('click', () => {
            selectionManager.setMode(mode);
        });
    }

    const selectionState = { info: 'None' };
    const selectionMonitor = selectionFolder.addBinding(selectionState, 'info', {
        label: 'Selected',
        readonly: true,
    });

    selectionFolder.addButton({ title: 'Clear Selection' }).on('click', () => {
        selectionManager.clearSelection();
    });

    selectionManager.onChange((selection) => {
        if (!selection) {
            selectionState.info = 'None';
        } else if (selection.mode === 'face') {
            selectionState.info = `Face #${selection.selectableFace.id} (${selection.selectableFace.triangles.length} tri)`;
        } else if (selection.mode === 'edge') {
            selectionState.info = `Edge #${selection.edge.id}`;
        } else {
            selectionState.info = `Vertex #${selection.vertex.id}`;
        }
        selectionMonitor.refresh();
    });

    selectionManager.onModeChange((mode) => {
        modeState.mode = mode;
        modeMonitor.refresh();
    });

    // --- Operations section --------------------------------------------------
    // Extrude is mouse-driven (see ExtrudeTool: press E with a face or
    // vertex selected, move the mouse, click/Enter to confirm, Esc/
    // right-click to cancel) rather than a button+slider — this panel
    // shows a hint by default, and surfaces why extrude couldn't start
    // when it fails, since most people won't have devtools open to see
    // the console warning.
    const operationsFolder = pane.addFolder({ title: 'Operations' });
    const operationsStatus = { text: 'Select a face or vertex, press E to extrude' };
    const operationsMonitor = operationsFolder.addBinding(operationsStatus, 'text', {
        label: 'Extrude',
        readonly: true,
    });

    const DEFAULT_HINT = 'Select a face or vertex, press E to extrude';
    let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
    extrudeTool.onStatus((message) => {
        operationsStatus.text = message;
        operationsMonitor.refresh();
        // Revert to the default hint after a few seconds rather than leaving
        // a stale failure message showing indefinitely.
        clearTimeout(statusClearTimer);
        statusClearTimer = setTimeout(() => {
            operationsStatus.text = DEFAULT_HINT;
            operationsMonitor.refresh();
        }, 4000);
    });

    // --- Display section ---------------------------------------------------
    const displayFolder = pane.addFolder({ title: 'Display' });
    const displayParams = { wireframe: false };
    displayFolder.addBinding(displayParams, 'wireframe', { label: 'Wireframe' })
        .on('change', (ev) => {
            viewport.setWireframe(ev.value);
        });

    return pane;
}