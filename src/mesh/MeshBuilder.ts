import * as THREE from 'three';

export function createPrimitive(type: 'box' | 'plane' | 'cylinder' | 'sphere', size: number = 1): THREE.BufferGeometry {
    switch (type) {
        case 'box':
            return new THREE.BoxGeometry(size, size, size);
        case 'plane':
            return new THREE.PlaneGeometry(size, size);
        case 'cylinder':
            return new THREE.CylinderGeometry(size/2, size/2, size, 32);
        case 'sphere':
            return new THREE.SphereGeometry(size/2, 32, 32);
        default:
            return new THREE.BoxGeometry(size, size, size);
    }
}