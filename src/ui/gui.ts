import { Pane } from 'tweakpane';
import * as THREE from 'three';
import { Viewport } from '../viewport.ts';
import type { ViewPreset } from '../viewport.ts';
import { createPrimitive } from '../mesh/MeshBuilder.ts';

const SPAWN_SPACING = 2.5;
const SPAWN_PER_ROW = 5;

export function setupGUI(viewport: Viewport) {
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
        const col = spawnCount % SPAWN_PER_ROW;
        const row = Math.floor(spawnCount / SPAWN_PER_ROW);
        const position = new THREE.Vector3(col * SPAWN_SPACING, 0, row * SPAWN_SPACING);
        viewport.addMesh(geometry, 0xffffff, position);
        spawnCount++;
    });

    primitivesFolder.addButton({ title: 'Clear Scene' }).on('click', () => {
        viewport.clearMeshes();
        spawnCount = 0;
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