import { Viewport } from './viewport';
import { setupGUI } from './ui/gui';
import { SelectionManager } from './selection/SelectionManager';
import { MoveTool } from './operations/MoveTool';
import { DeleteTool } from './operations/DeleteTool';
import { ExtrudeTool } from './operations/ExtrudeTool';
import { ScaleTool } from './operations/ScaleTool';
import { LoopCutTool } from './operations/LoopCutTool';
import { BevelTool } from './operations/BevelTool';
import { InteractionLock } from './operations/InteractionLock';
import { History } from './operations/History';

const viewport = new Viewport();
const selectionManager = new SelectionManager(viewport);

// Shared by every modal tool so only one can be mid-operation at a time.
const interactionLock = new InteractionLock();
selectionManager.setInteractionLock(interactionLock);

// Shared scene-level undo/redo — every tool records its committed
// actions here, and Ctrl+Z/Ctrl+Shift+Z work regardless of which tool
// produced the change.
const history = new History(viewport, selectionManager, interactionLock);

const moveTool = new MoveTool(viewport, selectionManager, interactionLock, history);
const deleteTool = new DeleteTool(viewport, selectionManager, interactionLock, history);
const extrudeTool = new ExtrudeTool(viewport, selectionManager, interactionLock, history);
const scaleTool = new ScaleTool(viewport, selectionManager, interactionLock, history);
const loopCutTool = new LoopCutTool(viewport, selectionManager, interactionLock, history);
const bevelTool = new BevelTool(viewport, selectionManager, interactionLock, history);

setupGUI(viewport, selectionManager, moveTool, deleteTool, extrudeTool, scaleTool, loopCutTool, bevelTool, interactionLock, history);

function animate() {
    requestAnimationFrame(animate);
    viewport.render();
}
animate();