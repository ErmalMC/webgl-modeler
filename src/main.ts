import { Viewport } from './viewport';
import { setupGUI } from './ui/gui';
import { SelectionManager } from './selection/SelectionManager';
import { MoveTool } from './operations/MoveTool';
import { ExtrudeTool } from './operations/ExtrudeTool';
import { ScaleTool } from './operations/ScaleTool';
import { LoopCutTool } from './operations/LoopCutTool';
import { BevelTool } from './operations/BevelTool';
import { InteractionLock } from './operations/InteractionLock';

const viewport = new Viewport();
const selectionManager = new SelectionManager(viewport);

// Shared by every modal tool so only one can be mid-operation at a time.
const interactionLock = new InteractionLock();
selectionManager.setInteractionLock(interactionLock);
const moveTool = new MoveTool(viewport, selectionManager, interactionLock);
const extrudeTool = new ExtrudeTool(viewport, selectionManager, interactionLock);
const scaleTool = new ScaleTool(viewport, selectionManager, interactionLock);
const loopCutTool = new LoopCutTool(viewport, selectionManager, interactionLock);
const bevelTool = new BevelTool(viewport, selectionManager, interactionLock);

setupGUI(viewport, selectionManager, moveTool, extrudeTool, scaleTool, loopCutTool, bevelTool, interactionLock);

function animate() {
    requestAnimationFrame(animate);
    viewport.render();
}
animate();