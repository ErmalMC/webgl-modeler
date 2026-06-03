# Viewport

## What it does
The viewport is the 3D canvas that fills the entire browser window. It is the
foundation of the entire application — every other feature renders inside it.

## How to use it
- **Left click + drag** — rotate the camera around the scene
- **Scroll wheel** — zoom in and out
- **Right click + drag** — pan the camera

## What is visible
- A dark background
- A 10x10 grid on the ground plane
- An axes helper showing orientation (red = X, green = Y, blue = Z)

## How it works technically
The viewport is built using Three.js on top of WebGL. It consists of:

- **Scene** — a container that holds all 3D objects, lights, and helpers
- **PerspectiveCamera** — simulates how a human eye sees in 3D with depth
- **WebGLRenderer** — draws the scene to a canvas element in the browser
- **OrbitControls** — handles mouse input for rotating, zooming, and panning
- **AmbientLight** — a soft light that illuminates everything equally
- **DirectionalLight** — a strong light from one direction that creates shading
- **GridHelper** — the reference grid on the ground plane
- **AxesHelper** — the red/green/blue axis indicator

## Files involved
- `src/viewport.ts` — the Viewport class
- `src/main.ts` — initializes the viewport and runs the animation loop

## Known limitations
- No orthographic camera mode yet (front/side/top view)
- No camera reset button yet