import { Viewport } from './viewport';
import { setupGUI } from './ui/gui';
import { SelectionManager } from './selection/SelectionManager';
import { ExtrudeTool } from './operations/ExtrudeTool';

const viewport = new Viewport();
const selectionManager = new SelectionManager(viewport);
const extrudeTool = new ExtrudeTool(viewport, selectionManager);
setupGUI(viewport, selectionManager, extrudeTool);

function animate() {
    requestAnimationFrame(animate);
    viewport.render();
}
animate();