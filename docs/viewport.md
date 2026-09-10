# Viewport

## What it does
The viewport is the 3D canvas that fills the entire browser window. It is the
foundation of the entire application — every other feature renders inside it.

## How to use it
**Mouse:**
- **Left click + drag** — rotate the camera around the scene
- **Scroll wheel** — zoom in and out
- **Right click + drag** — pan the camera

**Keyboard (numpad, Blender-style):**
| Key | Action |
|---|---|
| Numpad 5 | Toggle Perspective / Orthographic |
| Numpad 1 | Front view (orthographic) |
| Numpad 2 | Back view (orthographic) |
| Numpad 3 | Right view (orthographic) |
| Numpad 4 | Left view (orthographic) |
| Numpad 7 | Top view (orthographic) |
| Numpad 9 | Bottom view (orthographic) |
| Home | Reset camera to the startup view |

All numpad view presets switch the active camera to orthographic
automatically, matching Blender's convention — you don't need to press
Numpad 5 first.

## What is visible
- A dark background
- A 30x30 grid on the ground plane
- An axes helper showing orientation (red = X, green = Y, blue = Z)
- A Tweakpane control panel (top-right) for camera mode, view presets,
  primitive spawning, and a wireframe toggle

## How it works technically
The viewport is built using Three.js on top of WebGL. It consists of:

- **Scene** — a container that holds all 3D objects, lights, and helpers
- **PerspectiveCamera / OrthographicCamera** — both are created up front and
  kept alive; only one is ever "active" at a time. Toggling swaps which one
  `render()` and `OrbitControls` use, carrying over position and orientation
  so the switch doesn't jump the view.
- **WebGLRenderer** — draws the scene to a canvas element in the browser
- **OrbitControls** — handles mouse input for rotating, zooming, and panning;
  re-pointed at whichever camera is currently active
- **AmbientLight** — a soft light that illuminates everything equally
- **DirectionalLight** — a strong light from one direction that creates shading
- **GridHelper** — the reference grid on the ground plane (30x30)
- **AxesHelper** — the red/green/blue axis indicator

Numpad view presets (front/back/left/right/top/bottom) reposition the active
camera at a fixed distance from the current orbit target, force orthographic
mode, and adjust the camera's `up` vector for top/bottom views to avoid
gimbal-lock artifacts when looking straight down or up.

`resetCamera()` (Home key, or the "Reset Camera" button) restores both
cameras' position, orientation, and `up` vector to the same
`HOME_POSITION` constant the constructor uses, resets the orbit target
to the origin, and switches back to perspective — undoing any amount of
pan/zoom/orbit/view-preset drift in one step, regardless of which camera
was active or how far `up` had been knocked off-axis by a top/bottom
view.

## Files involved
- `src/viewport.ts` — the Viewport class (cameras, controls, mesh tracking,
  wireframe mode)
- `src/main.ts` — initializes the viewport, GUI, and runs the animation loop
- `src/ui/gui.ts` — Tweakpane panel: camera mode/view/reset buttons,
  primitive spawner, Clear Scene, wireframe toggle
- `src/mesh/MeshBuilder.ts` — generates primitive geometries (cube, plane,
  cylinder, sphere) for the GUI to spawn

## Known limitations
- Toggling wireframe mode applies to all meshes, not per-object
- Primitive grid spawn layout only expands outward (+X/+Z); it doesn't
  reuse freed slots after Clear Scene beyond restarting at the origin