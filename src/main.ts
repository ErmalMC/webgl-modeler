import { Viewport } from './viewport';
import { setupGUI } from './ui/gui';

const viewport = new Viewport();
setupGUI(viewport);

function animate() {
    requestAnimationFrame(animate);
    viewport.render();
}
animate();