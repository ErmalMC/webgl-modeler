import { Viewport } from './viewport';
import { setupGUI } from './ui/gui';
import { SelectionManager } from './selection/SelectionManager';

const viewport = new Viewport();
const selectionManager = new SelectionManager(viewport);
setupGUI(viewport, selectionManager);

function animate() {
    requestAnimationFrame(animate);
    viewport.render();
}
animate();