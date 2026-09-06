import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { HalfEdgeMesh } from './mesh/Halfedgemesh.ts';

export type ViewPreset = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

export class Viewport {
  scene: THREE.Scene;

  perspectiveCamera: THREE.PerspectiveCamera;
  orthographicCamera: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;

  private orbitRadius = 7.2;

  private meshes: THREE.Mesh[] = [];

  // Only meshes added via addPrimitive() have an entry here — helper
  // objects (grid, axes) and anything added via addMesh() are display-only.
  private halfEdgeMeshes = new Map<THREE.Mesh, HalfEdgeMesh>();

  private wireframeEnabled = false;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1a);

    this.perspectiveCamera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        10000
    );
    this.perspectiveCamera.position.set(4, 4, 6);
    this.perspectiveCamera.lookAt(0, 0, 0);

    // Framed to roughly match the perspective view at the same distance.
    const aspect = window.innerWidth / window.innerHeight;
    const orthoSize = 5;
    this.orthographicCamera = new THREE.OrthographicCamera(
        -orthoSize * aspect,
        orthoSize * aspect,
        orthoSize,
        -orthoSize,
        0.1,
        10000
    );
    this.orthographicCamera.position.copy(this.perspectiveCamera.position);
    this.orthographicCamera.lookAt(0, 0, 0);

    this.camera = this.perspectiveCamera;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 5);
    this.scene.add(dirLight);

    const grid = new THREE.GridHelper(30, 30, 0x444444, 0x333333);
    this.scene.add(grid);

    const axes = new THREE.AxesHelper(2);
    this.scene.add(axes);

    window.addEventListener('resize', () => {
      this.updateCameraAspect();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    window.addEventListener('keydown', (e) => this.handleKeydown(e));
  }

  private updateCameraAspect(): void {
    const aspect = window.innerWidth / window.innerHeight;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = aspect;
    } else {
      const orthoSize = 5;
      this.camera.left = -orthoSize * aspect;
      this.camera.right = orthoSize * aspect;
      this.camera.top = orthoSize;
      this.camera.bottom = -orthoSize;
    }
    this.camera.updateProjectionMatrix();
  }

  private handleKeydown(e: KeyboardEvent): void {
    // Numpad only — ignore top-row digits so typing elsewhere isn't hijacked.
    switch (e.code) {
      case 'Numpad5':
        this.toggleCameraType();
        break;
      case 'Numpad1':
        this.setView(e.shiftKey ? 'back' : 'front');
        break;
      case 'Numpad3':
        this.setView(e.shiftKey ? 'left' : 'right');
        break;
      case 'Numpad7':
        this.setView(e.shiftKey ? 'bottom' : 'top');
        break;
      case 'Numpad2':
        this.setView('back');
        break;
      case 'Numpad4':
        this.setView('left');
        break;
      case 'Numpad9':
        this.setView('bottom');
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  toggleCameraType(): void {
    const isPerspective = this.camera instanceof THREE.PerspectiveCamera;
    const from = this.camera;
    const to = isPerspective ? this.orthographicCamera : this.perspectiveCamera;

    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);

    this.camera = to;
    this.updateCameraAspect();

    this.controls.object = this.camera;
    this.controls.update();
  }

  setView(preset: ViewPreset): void {
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.toggleCameraType();
    }

    const target = this.controls.target.clone();
    const dist = this.orbitRadius;
    const dirs: Record<ViewPreset, THREE.Vector3> = {
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1),
      right: new THREE.Vector3(1, 0, 0),
      left: new THREE.Vector3(-1, 0, 0),
      top: new THREE.Vector3(0, 1, 0),
      bottom: new THREE.Vector3(0, -1, 0),
    };

    const dir = dirs[preset];
    this.camera.position.copy(target.clone().addScaledVector(dir, dist));

    // Avoid gimbal-lock artifacts looking straight down/up.
    const up = preset === 'top' ? new THREE.Vector3(0, 0, -1)
        : preset === 'bottom' ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0);
    this.camera.up.copy(up);
    this.camera.lookAt(target);
    this.controls.update();
  }

  setWireframe(enabled: boolean): void {
    this.wireframeEnabled = enabled;
    for (const mesh of this.meshes) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if ('wireframe' in mat) {
          (mat as THREE.MeshStandardMaterial).wireframe = enabled;
        }
      }
    }
  }

  addMesh(
      geometry: THREE.BufferGeometry,
      color: number = 0xffffff,
      position: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
  ): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.3,
      metalness: 0.1,
      side: THREE.DoubleSide,
      wireframe: this.wireframeEnabled,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  /** Adds an editable primitive, linking a rendered mesh to its HalfEdgeMesh so operations can mutate topology and refreshPrimitive() to sync it to screen. */
  addPrimitive(
      halfEdgeMesh: HalfEdgeMesh,
      color: number = 0xffffff,
      position: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
  ): THREE.Mesh {
    const geometry = halfEdgeMesh.toBufferGeometry();
    const mesh = this.addMesh(geometry, color, position);
    this.halfEdgeMeshes.set(mesh, halfEdgeMesh);
    return mesh;
  }

  getPrimitiveMeshes(): THREE.Mesh[] {
    return Array.from(this.halfEdgeMeshes.keys());
  }

  getHalfEdgeMesh(mesh: THREE.Mesh): HalfEdgeMesh | undefined {
    return this.halfEdgeMeshes.get(mesh);
  }

  /** Call after any operation that mutates a mesh's topology, to push the change to screen. */
  refreshPrimitive(mesh: THREE.Mesh): void {
    const halfEdgeMesh = this.halfEdgeMeshes.get(mesh);
    if (!halfEdgeMesh) return;
    mesh.geometry.dispose();
    mesh.geometry = halfEdgeMesh.toBufferGeometry();
  }

  clearMeshes(): void {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }
    this.meshes = [];
    this.halfEdgeMeshes.clear();
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
