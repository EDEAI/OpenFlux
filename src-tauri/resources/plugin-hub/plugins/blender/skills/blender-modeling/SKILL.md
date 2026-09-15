---
name: blender-modeling
description: Build presentable 3D models, dioramas and product scenes in Blender with bpy scripts — plan the parts, build with the tested ofx_blender_kit helpers, self-check geometry, render a preview, look at it, iterate, then deliver a .blend that opens in colour.
version: 1.0.0
---

# Blender modeling (bpy, headless)

Use this whenever the user wants something *made in Blender*: a house, a room, a
product, a vehicle, a low-poly scene, an animation-ready model. Blender is driven
headless through a Python script; the user gets a `.blend` plus preview renders.

## The workflow (do all steps, in order)

1. **Find Blender.** Windows: `C:\Program Files\Blender Foundation\Blender <ver>\blender.exe`
   (also try `where blender`); macOS: `/Applications/Blender.app/Contents/MacOS/Blender`;
   Linux: `blender`. Run `"<blender>" --version` once. Needs 4.2 or newer.
2. **Write a plan before any code** — a short parts list with dimensions in metres, in
   the reply and as a comment block at the top of the script. Minimum bar for a
   "building": footprint, storeys, roof type, doors, windows per side, porch/steps,
   chimney, ground/diorama base, 2–3 garden props, camera angle. For a product: body,
   3–6 visible sub-parts, material list. **A single box with a roof is a failed result.**
3. **Build with the kit.** Read `scripts/example_cozy_house.py` (next to this file) with the
   `filesystem` read action (`file_reader` cannot open .py) and use it as the starting point —
   edit its plan section. The kit is `scripts/ofx_blender_kit.py` — **do not read its source**, the API
   table below is complete; only open it if a call fails. Import it with the absolute path of that directory:
   ```python
   import sys; sys.path.insert(0, r"<absolute path to this skill's scripts dir>")
   import ofx_blender_kit as K
   ```
   Put the script and outputs in the task's output folder (not inside the plugin).
4. **Run headless** and keep the log:
   ```
   "<blender>" --background --factory-startup --python build.py -- --out "<out dir>"
   ```
   Use `process` with a 5–10 minute timeout; a big scene renders in 20–60 s.
5. **Read the self-check** — the log has one line `OFX_SCENE_CHECK {...}`:
   - `floating_unattached` must be empty or only tiny decor (flowers, pebbles). A window,
     door, roof, step or chimney listed here is **misplaced** — fix the coordinates.
   - `objects` should be dozens to hundreds for a building; `materials_with_viewport_color`
     must equal `materials`.
6. **Look at the preview** (`<name>_preview.png`) with `file_reader` and grade it against
   the checklist below. Fix and re-run. Do at least one revision round; stop when the
   checklist passes, max 3 rounds.
7. **Deliver**: final `.blend` (saved by `K.finish`, opens in Material Preview through the
   camera), the preview PNG, and — if the user is on this machine — open it with
   `process spawn "<blender>" "<file>.blend"`. Summarise the parts list and dimensions.

## Preview checklist (what "good" looks like)

- Parts touch what they belong to: windows/doors sit *in* the wall plane, roof rests on
  the wall top with an overhang, steps meet the door sill, chimney passes through the roof.
- Proportions: storey 2.6–3.0 m, door 0.9–1.1 × 2.1 m, window 1.0–1.3 × 1.2–1.4 m,
  roof pitch 30–40°, fence 1.0–1.2 m.
- Colour and material variety: at least 6 distinct materials; tiles/stone/leaves use
  `K.palette()` so surfaces are not flat single tones.
- Detail density: trim, sills, shutters, quoins, beams, tiles, railings — small repeated
  parts are what make a model read as "finished".
- Framing: the whole model inside the frame with margin; three-quarter view; nothing
  clipped; background not black (kit adds a neutral backdrop).
- No z-fighting (coplanar faces) — offset overlapping parts by ≥ 1 cm.

## Kit API (sizes are FULL extents, positions are bottom-centre, metres, +Z up)

| Call | What it does |
| --- | --- |
| `K.reset_scene()` | wipe everything; call first |
| `K.mat(name, "#rrggbb" or (r,g,b), roughness, metallic)` | material visible in Solid + Material Preview |
| `K.palette(name, color, n, spread)` | n shades of one colour (tiles, stone, leaves) |
| `K.box(name, (w,d,h), (x,y,z), mat, coll, bevel_width, center=False)` | box standing on z (or centred if `center=True`) |
| `K.mesh(name, verts, faces, mat, coll, bevel_width, solidify)` | custom mesh from world coords |
| `K.cylinder / K.sphere / K.cone / K.beam(a, b, thickness)` | primitives; beam is a bar between two points |
| `K.cut(target, cutter)` | boolean opening (real holes in walls) |
| `K.gable_roof(name, ridge_len, depth, height, (x,y,eave_z), mat, overhang, ridge_axis='X'|'Y')` | pitched roof prism sitting on the wall top |
| `K.hip_roof(name, w, d, h, (x,y,eave_z), mat)` | four-slope roof |
| `K.roof_tiles(name, a, b, c, d, mats, rows, cols)` | individual tiles over the quad a→b (bottom edge), d→c (top edge) |
| `K.window(name, side, u, sill_z, w, h, wall_center, wall_size, frame_mat, glass_mat, shutter_mat)` | complete window flush on a wall block (`side` = front/back/left/right, `u` = along the wall) |
| `K.door(name, side, u, w, h, wall_center, wall_size, door_mat, z=floor)` | panelled door with frame and knob |
| `K.stairs(name, width, steps, step_h, step_d, (x,y,top_z), direction)` | steps descending from a landing |
| `K.fence(name, a, b, height)` / `K.tree(name, at, height)` / `K.bush(name, at, r)` | garden props |
| `K.ground(name, (w,d), (x,y,0), grass_mat)` / `K.backdrop()` | diorama slab whose top is z=0; neutral floor |
| `K.camera(azimuth_deg, elevation_deg, ortho, margin)` | auto-framed three-quarter camera |
| `K.lights(sun_strength, world_strength)` | sun + fill + sky |
| `K.check_scene()` | prints `OFX_SCENE_CHECK` json (floating parts, counts, bounds) |
| `K.finish(out_dir, name, description, preview=True, engine='EEVEE', samples, resolution, final=False)` | check → save .blend (Material Preview, camera view) → preview render; `final=True` adds a Cycles render |

Anything the kit lacks (curves, arrays, text, animation keyframes) is plain `bpy`; keep the
kit's conventions (full sizes, bottom-anchored, materials via `K.mat`).

## Pitfalls the kit already avoids — do not reintroduce them

- `bpy.ops.mesh.primitive_cube_add(size=1)` then `obj.scale = size/2` gives **half** the
  intended size (`size=1` is the edge length). Use `K.box`.
- Materials set only through `Principled BSDF` look grey in the default Solid viewport;
  the user opens the file and sees a grey model. `K.mat` sets `diffuse_color` and
  `K.save` switches the viewport to Material Preview.
- A camera placed by guesswork cuts the model off; `K.camera()` frames the bounds.
- Do not render with the default black world; `K.lights()` adds a sky.
- Use `--factory-startup` so user preferences/addons cannot break the script, and
  never rely on `bpy.context.object` after your own `bpy.data` calls.

## Animation / turntable (optional)

For a turntable, parent the camera to an empty at the model centre and keyframe the
empty's Z rotation 0→360° over 120 frames; render with
`"<blender>" --background file.blend -a` after `K.set_render('EEVEE', 16, (960,720), "<out>/frame_####.png")`.
