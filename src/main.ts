import { Viewport } from './viewport'

const viewport = new Viewport()

function animate() {
    requestAnimationFrame(animate)
    viewport.render()
}

animate()