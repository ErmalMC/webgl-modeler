import { Pane } from 'tweakpane';
import * as THREE from 'three';
import { Viewport } from '../viewport.ts';
import type { ViewPreset } from '../viewport.ts';
import { createPrimitive } from '../mesh/MeshBuilder.ts';
import { HalfEdgeMesh } from '../mesh/Halfedgemesh.ts';
import type { SelectionManager } from '../selection/SelectionManager.ts';
import type { ExtrudeTool } from '../operations/ExtrudeTool.ts';
import type { ScaleTool } from '../operations/ScaleTool.ts';
import type { LoopCutTool } from '../operations/LoopCutTool.ts';
import type { BevelTool } from '../operations/BevelTool.ts';
import type { MoveTool } from '../operations/MoveTool.ts';
import type { DeleteTool } from '../operations/DeleteTool.ts';
import type { InteractionLock } from '../operations/InteractionLock.ts';
import type { History } from '../operations/History.ts';

const SPAWN_SPACING = 2.5;
const SPAWN_PER_ROW = 5;

/**
 * Sets up a status row for a modal tool: key-badge + label on the left,
 * live status text on the right, reverting to the default hint a few
 * seconds after a tool.onStatus() message.
 */
function setupOperationStatusRow(
    folder: ReturnType<Pane['addFolder']>,
    keyLabel: string,
    opLabel: string,
    defaultHint: string,
    onStatus: (listener: (message: string) => void) => void
): void {
    const state = { text: defaultHint };
    const monitor = folder.addBinding(state, 'text', { label: opLabel, readonly: true });

    const labelEl = monitor.element.querySelector('.tp-lblv_l');
    if (labelEl) {
        labelEl.innerHTML = '';
        const badge = document.createElement('span');
        badge.className = 'op-key';
        badge.textContent = keyLabel;
        labelEl.appendChild(badge);
        labelEl.appendChild(document.createTextNode(opLabel));
    }

    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    onStatus((message) => {
        state.text = message;
        monitor.refresh();
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => {
            state.text = defaultHint;
            monitor.refresh();
        }, 4000);
    });
}

/**
 * Adds drag handles for panel width (left edge) and max-height
 * (bottom-right corner) directly on the pane's root element, since
 * Tweakpane doesn't ship a resize affordance of its own.
 */
function setupResizableSize(pane: Pane): void {
    const MIN_WIDTH = 220;
    const MAX_WIDTH = 640;
    const MIN_HEIGHT = 160;

    const root = pane.element as HTMLElement;
    root.style.position = 'fixed';

    function currentWidthPx(): number {
        return root.getBoundingClientRect().width;
    }
    function currentMaxHeightPx(): number {
        return root.getBoundingClientRect().height;
    }

    const widthHandle = document.createElement('div');
    widthHandle.title = 'Drag to resize panel width';
    Object.assign(widthHandle.style, {
        position: 'absolute',
        top: '0',
        left: '-4px',
        width: '8px',
        height: '100%',
        cursor: 'ew-resize',
        zIndex: '10000',
    } satisfies Partial<CSSStyleDeclaration>);
    root.appendChild(widthHandle);

    widthHandle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        widthHandle.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startWidth = currentWidthPx();

        const onMove = (moveEvent: PointerEvent) => {
            // Panel is right-anchored, so dragging left grows it.
            const dx = moveEvent.clientX - startX;
            const nextWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth - dx));
            root.style.width = `${nextWidth}px`;
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });

    const heightHandle = document.createElement('div');
    heightHandle.title = 'Drag to resize panel height';
    Object.assign(heightHandle.style, {
        position: 'absolute',
        right: '2px',
        bottom: '-4px',
        width: '20px',
        height: '8px',
        cursor: 'ns-resize',
        zIndex: '10000',
    } satisfies Partial<CSSStyleDeclaration>);
    root.appendChild(heightHandle);

    heightHandle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        heightHandle.setPointerCapture(e.pointerId);
        const startY = e.clientY;
        const startHeight = currentMaxHeightPx();
        const viewportMax = window.innerHeight - 24;

        const onMove = (moveEvent: PointerEvent) => {
            const dy = moveEvent.clientY - startY;
            const nextHeight = Math.min(viewportMax, Math.max(MIN_HEIGHT, startHeight + dy));
            root.style.maxHeight = `${nextHeight}px`;
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });

    // Clamp back down if the browser window shrinks.
    window.addEventListener('resize', () => {
        const viewportMax = window.innerHeight - 24;
        if (currentMaxHeightPx() > viewportMax) {
            root.style.maxHeight = `${Math.max(MIN_HEIGHT, viewportMax)}px`;
        }
        if (currentWidthPx() > window.innerWidth - 24) {
            root.style.width = `${Math.max(MIN_WIDTH, window.innerWidth - 24)}px`;
        }
    });
}

export function setupGUI(viewport: Viewport, selectionManager: SelectionManager, moveTool: MoveTool, deleteTool: DeleteTool, extrudeTool: ExtrudeTool, scaleTool: ScaleTool, loopCutTool: LoopCutTool, bevelTool: BevelTool, interactionLock: InteractionLock, history: History) {
    const pane = new Pane({ title: 'WebGL Modeler' });
    pane.element.style.width = '300px';
    pane.element.style.position = 'fixed';
    pane.element.style.top = '12px';
    pane.element.style.right = '12px';
    pane.element.style.maxHeight = 'calc(100vh - 24px)';
    pane.element.style.overflowY = 'auto';
    setupResizableSize(pane);

    // --- Camera section -------------------------------------------------
    const cameraFolder = pane.addFolder({ title: 'Camera' });

    const cameraState = { type: viewport.camera.type };
    const cameraMonitor = cameraFolder.addBinding(cameraState, 'type', {
        label: 'Mode',
        readonly: true,
    });

    cameraFolder.addButton({ title: 'Toggle Ortho / Persp (5)' })
        .on('click', () => {
            viewport.toggleCameraType();
            cameraState.type = viewport.camera.type;
            cameraMonitor.refresh();
        });

    const numpadHintState = { text: 'Numpad  1 front · 3 right · 7 top · Shift+digit for opposite · 5 toggle' };
    const numpadHint = cameraFolder.addBinding(numpadHintState, 'text', { label: '', readonly: true });
    numpadHint.element.classList.add('hint-row');

    const viewButtons: { title: string; preset: ViewPreset }[] = [
        { title: 'Front', preset: 'front' },
        { title: 'Back', preset: 'back' },
        { title: 'Right', preset: 'right' },
        { title: 'Left', preset: 'left' },
        { title: 'Top', preset: 'top' },
        { title: 'Bottom', preset: 'bottom' },
    ];
    for (const { title, preset } of viewButtons) {
        const btn = cameraFolder.addButton({ title });
        btn.element.classList.add('grid-btn');
        btn.on('click', () => {
            viewport.setView(preset);
            cameraState.type = viewport.camera.type;
            cameraMonitor.refresh();
        });
    }

    // Numpad shortcuts change the camera outside the pane's knowledge, so poll to stay in sync.
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

    primitivesFolder.addButton({ title: 'Add Primitive' }).on('click', () => {
        const geometry = createPrimitive(primitiveParams.type, primitiveParams.size);
        const halfEdgeMesh = HalfEdgeMesh.fromBufferGeometry(geometry);

        const result = halfEdgeMesh.validate();
        if (!result.valid) {
            console.error(`HalfEdgeMesh validation failed for new ${primitiveParams.type}:`, result.errors);
        }

        // Derived fresh each time rather than a tracked counter, so grid
        // layout stays correct after undo/redo changes the primitive count.
        const spawnIndex = viewport.getPrimitiveMeshes().length;
        const col = spawnIndex % SPAWN_PER_ROW;
        const row = Math.floor(spawnIndex / SPAWN_PER_ROW);
        const position = new THREE.Vector3(col * SPAWN_SPACING, 0, row * SPAWN_SPACING);

        history.beginAction('Add Primitive');
        viewport.addPrimitive(halfEdgeMesh, 0xffffff, position);
        history.commitAction();
    });

    primitivesFolder.addButton({ title: 'Clear Scene' }).on('click', () => {
        // Refuse while a modal tool is mid-drag — its handle would end up
        // pointing at geometry that's about to be deleted.
        if (interactionLock.isLocked()) return;
        history.beginAction('Clear Scene');
        viewport.clearMeshes();
        selectionManager.clearSelection();
        history.commitAction();
    });

    // --- Selection section --------------------------------------------------
    const selectionFolder = pane.addFolder({ title: 'Selection' });

    const modeButtons: { title: string; mode: 'face' | 'edge' | 'vertex' }[] = [
        { title: 'Face', mode: 'face' },
        { title: 'Edge', mode: 'edge' },
        { title: 'Vertex', mode: 'vertex' },
    ];
    const modeButtonEls = new Map<'face' | 'edge' | 'vertex', HTMLElement>();
    for (const { title, mode } of modeButtons) {
        const btn = selectionFolder.addButton({ title });
        btn.element.classList.add('segment-btn');
        modeButtonEls.set(mode, btn.element);
        btn.on('click', () => selectionManager.setMode(mode));
    }

    function refreshModeSegments(mode: 'face' | 'edge' | 'vertex'): void {
        for (const [m, el] of modeButtonEls) {
            el.classList.toggle('segment-active', m === mode);
        }
    }
    refreshModeSegments(selectionManager.mode);
    selectionManager.onModeChange(refreshModeSegments);

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

    // --- Operations section --------------------------------------------------
    const operationsFolder = pane.addFolder({ title: 'Operations' });

    setupOperationStatusRow(operationsFolder, 'G', 'Move', 'Select any part of an object, press G to move it', (l) => moveTool.onStatus(l));
    setupOperationStatusRow(operationsFolder, 'Del', 'Delete', 'Select a face, edge, or vertex, press Delete to remove it', (l) => deleteTool.onStatus(l));
    setupOperationStatusRow(operationsFolder, 'E', 'Extrude', 'Select a face or vertex, press E to extrude', (l) => extrudeTool.onStatus(l));
    setupOperationStatusRow(operationsFolder, 'S', 'Scale', 'Select a face or edge, press S to scale', (l) => scaleTool.onStatus(l));
    setupOperationStatusRow(operationsFolder, '^R', 'Loop Cut', 'Select an edge, press Ctrl+R to loop cut', (l) => loopCutTool.onStatus(l));
    setupOperationStatusRow(operationsFolder, '^B', 'Bevel', 'Select an edge, press Ctrl+B to bevel', (l) => bevelTool.onStatus(l));

    // --- History section -----------------------------------------------
    const historyFolder = pane.addFolder({ title: 'History' });
    setupOperationStatusRow(historyFolder, '^Z', 'Undo/Redo', 'Ctrl+Z to undo, Ctrl+Shift+Z to redo', (l) => history.onStatus(l));
    historyFolder.addButton({ title: 'Undo' }).on('click', () => history.undo());
    historyFolder.addButton({ title: 'Redo' }).on('click', () => history.redo());

    // --- Display section ---------------------------------------------------
    const displayFolder = pane.addFolder({ title: 'Display' });
    const displayParams = { wireframe: false };
    displayFolder.addBinding(displayParams, 'wireframe', { label: 'Wireframe' })
        .on('change', (ev) => {
            viewport.setWireframe(ev.value);
        });

    return pane;
}