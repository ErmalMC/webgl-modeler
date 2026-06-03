import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export class Viewport {
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    renderer: THREE.WebGLRenderer
    controls: OrbitControls

    constructor() {
        // Scene
        this.scene = new THREE.Scene()
        this.scene.background = new THREE.Color(0x1a1a1a)

        // Camera
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            10000
        )
        this.camera.position.set(4, 4, 6)
        this.camera.lookAt(0, 0, 0)

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true })
        this.renderer.setSize(window.innerWidth, window.innerHeight)
        this.renderer.setPixelRatio(window.devicePixelRatio)
        document.body.appendChild(this.renderer.domElement)

        // Orbit controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement)
        this.controls.enableDamping = true
        this.controls.dampingFactor = 0.05

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5)
        this.scene.add(ambientLight)

        const dirLight = new THREE.DirectionalLight(0xffffff, 1)
        dirLight.position.set(5, 10, 5)
        this.scene.add(dirLight)

        // Grid
        const grid = new THREE.GridHelper(30, 30, 0x444444, 0x333333)
        this.scene.add(grid)

        // Axes helper (red = X, green = Y, blue = Z)
        const axes = new THREE.AxesHelper(2)
        this.scene.add(axes)

        // Handle window resize
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight
            this.camera.updateProjectionMatrix()
            this.renderer.setSize(window.innerWidth, window.innerHeight)
        })
    }

    render() {
        this.controls.update()
        this.renderer.render(this.scene, this.camera)
    }
}