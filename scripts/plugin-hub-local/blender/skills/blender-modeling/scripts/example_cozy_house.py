# -*- coding: utf-8 -*-
"""
Reference scene: a two-storey cottage diorama built with ofx_blender_kit.
Run headless:
  blender --background --factory-startup --python example_cozy_house.py -- --out <dir> [--final]

Copy this file as the starting point for any building/diorama request and
change the plan section; keep the finish() call so you get the self-check,
the .blend in Material Preview and a preview render to look at.
"""
import os
import sys
import random

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ofx_blender_kit as K  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else os.path.join(HERE, "out")
FINAL = "--final" in argv

K.reset_scene()
random.seed(3)

# ---- plan (metres) --------------------------------------------------------
W, D = 6.4, 5.2          # house footprint
FLOOR_H = 2.7            # storey height
FLOORS = 2
WALL_TOP = 0.3 + FLOOR_H * FLOORS   # foundation 0.3 + 2 storeys
ROOF_H = 2.2

# ---- materials ------------------------------------------------------------
plaster = K.mat("Plaster", "#efe6d2", 0.75)
trim = K.mat("Trim", "#fbf7ee", 0.6)
wood = K.mat("Walnut", "#4b2c16", 0.55)
oak = K.mat("Oak door", "#8a4f24", 0.5)
sage = K.mat("Sage shutters", "#5d8a72", 0.6)
glass = K.mat("Glass", "#79b0c7", 0.15, 0.35)
stone = K.palette("Limestone", "#bdb4a3", 4, 0.15)
tiles = K.palette("Terracotta", "#c8694a", 6, 0.22, 0.8)
brick = K.palette("Brick", "#a5533c", 4, 0.18, 0.85)
grass = K.mat("Lawn", "#8dbb5e", 0.9)
leaves = K.palette("Leaf", "#5f9a3c", 5, 0.3)
flowers = [K.mat("Flower cream", "#f6d27a"), K.mat("Flower coral", "#e2543a"), K.mat("Flower pink", "#d9709b")]

# ---- ground & backdrop ----------------------------------------------------
K.backdrop()
K.ground("Garden", (13.0, 12.0), (0, -0.6, 0), grass)

# ---- house body -----------------------------------------------------------
K.box("Foundation", (W + 0.3, D + 0.3, 0.3), (0, 0, 0), stone[2], "01 Structure", 0.03)
K.box("Walls", (W, D, FLOOR_H * FLOORS), (0, 0, 0.3), plaster, "01 Structure", 0.02)
# floor belt course between storeys + corner quoins
for y in (-D / 2 - 0.06, D / 2 + 0.06):
    K.box("Belt course", (W + 0.12, 0.12, 0.12), (0, y, 0.3 + FLOOR_H), trim, "01 Structure", 0.01)
for x in (-W / 2 - 0.06, W / 2 + 0.06):
    K.box("Belt course side", (0.12, D + 0.12, 0.12), (x, 0, 0.3 + FLOOR_H), trim, "01 Structure", 0.01)
for x in (-W / 2, W / 2):
    for y in (-D / 2, D / 2):
        for k in range(14):
            K.box("Quoin", (0.3, 0.3, 0.26), (x, y, 0.3 + k * 0.38), trim, "01 Structure", 0.015)

# ---- windows & door -------------------------------------------------------
wall = dict(wall_center=(0, 0), wall_size=(W, D), frame_mat=trim, glass_mat=glass, bar_mat=wood, sill_mat=stone[3])
for u in (-2.0, 2.0):
    K.window(f"Front window {u} ground", "front", u, 1.3, 1.2, 1.35, shutter_mat=sage, **wall)
    K.window(f"Front window {u} upper", "front", u, 0.3 + FLOOR_H + 1.0, 1.2, 1.15, shutter_mat=sage, **wall)
for u in (-1.3, 1.3):
    K.window(f"Right window {u} ground", "right", u, 1.3, 1.1, 1.35, **wall)
    K.window(f"Right window {u} upper", "right", u, 0.3 + FLOOR_H + 1.0, 1.1, 1.15, **wall)
    K.window(f"Left window {u} ground", "left", u, 1.3, 1.1, 1.35, **wall)
    K.window(f"Back window {u} upper", "back", u, 0.3 + FLOOR_H + 1.0, 1.2, 1.15, **wall)
K.door("Front door", "front", 0, 1.1, 2.15, wall_center=(0, 0), wall_size=(W, D), door_mat=oak, frame_mat=trim, z=0.3)

# ---- roof -----------------------------------------------------------------
# ridge runs along Y (gables face front/back): width = ridge length (D), depth = across (W)
roof = K.gable_roof("Roof", D, W, ROOF_H, (0, 0, WALL_TOP), wood, overhang=0.45, thickness=0.14, ridge_axis='Y')
# gable fascia beams and ridge beam
ov = 0.45
for y in (-D / 2 - ov, D / 2 + ov):
    K.beam("Fascia", (-W / 2 - ov, y, WALL_TOP), (0, y, WALL_TOP + ROOF_H), 0.16, wood, "Roof")
    K.beam("Fascia", (W / 2 + ov, y, WALL_TOP), (0, y, WALL_TOP + ROOF_H), 0.16, wood, "Roof")
K.beam("Ridge", (0, -D / 2 - ov - 0.05, WALL_TOP + ROOF_H + 0.06), (0, D / 2 + ov + 0.05, WALL_TOP + ROOF_H + 0.06), 0.2, tiles[3], "Roof")
# individual tiles on both slopes (a,b bottom edge; d,c top edge)
xw = W / 2 + ov
yd = D / 2 + ov
K.roof_tiles("Tile L", (-xw, -yd, WALL_TOP), (-xw, yd, WALL_TOP), (0, yd, WALL_TOP + ROOF_H), (0, -yd, WALL_TOP + ROOF_H), tiles, rows=9, cols=14, lift=0.12)
K.roof_tiles("Tile R", (xw, yd, WALL_TOP), (xw, -yd, WALL_TOP), (0, -yd, WALL_TOP + ROOF_H), (0, yd, WALL_TOP + ROOF_H), tiles, rows=9, cols=14, lift=0.12)
# gable triangles (closed) — a thin prism inside the roof at both ends
for y in (-D / 2, D / 2):
    K.mesh("Gable", [(-W / 2, y - 0.05, WALL_TOP), (W / 2, y - 0.05, WALL_TOP), (0, y - 0.05, WALL_TOP + ROOF_H * 0.93),
                     (-W / 2, y + 0.05, WALL_TOP), (W / 2, y + 0.05, WALL_TOP), (0, y + 0.05, WALL_TOP + ROOF_H * 0.93)],
           [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)], plaster, "Roof")
    K.beam("Gable beam", (-W / 2 + 0.1, y, WALL_TOP + 0.02), (W / 2 - 0.1, y, WALL_TOP + 0.02), 0.14, wood, "Roof")
    K.beam("King post", (0, y, WALL_TOP), (0, y, WALL_TOP + ROOF_H * 0.9), 0.12, wood, "Roof")

# ---- chimney --------------------------------------------------------------
cx, cy = 1.7, 1.0
K.box("Chimney", (0.7, 0.75, 3.4), (cx, cy, WALL_TOP + 0.9), brick[1], "Roof", 0.02)
for r in range(9):
    for i in range(3):
        K.box("Chimney brick", (0.21, 0.06, 0.2), (cx - 0.24 + i * 0.24, cy - 0.4, WALL_TOP + 1.9 + r * 0.24), brick[(i + r) % 4], "Roof", 0.01)
K.box("Chimney cap", (0.9, 0.95, 0.16), (cx, cy, WALL_TOP + 4.3), stone[0], "Roof", 0.03)

# ---- porch ----------------------------------------------------------------
PY = -D / 2
K.box("Porch deck", (3.2, 1.7, 0.3), (0, PY - 0.85, 0), stone[3], "Porch", 0.04)
K.stairs("Entry step", 3.0, 3, 0.1, 0.35, (0, PY - 1.7, 0.3), '-Y', stone[2], "Porch")
for x in (-1.45, 1.45):
    K.box("Porch post", (0.15, 0.15, 2.5), (x, PY - 1.55, 0.3), wood, "Porch", 0.02)
    K.box("Post foot", (0.24, 0.24, 0.26), (x, PY - 1.55, 0.3), trim, "Porch", 0.02)
    K.beam("Porch bracket", (x, PY - 1.55, 2.5), (x * 0.65, PY - 1.55, 2.85), 0.09, wood, "Porch")
K.box("Porch header", (3.2, 0.18, 0.2), (0, PY - 1.6, 2.8), wood, "Porch", 0.02)
porch_roof = K.mesh("Porch roof", [(-1.75, PY, 3.35), (1.75, PY, 3.35), (1.75, PY - 1.85, 2.95), (-1.75, PY - 1.85, 2.95)], [(3, 2, 1, 0)], wood, "Porch", solidify=0.1)
K.roof_tiles("Porch tile", (-1.75, PY - 1.85, 2.95), (1.75, PY - 1.85, 2.95), (1.75, PY, 3.35), (-1.75, PY, 3.35), tiles, rows=5, cols=9, lift=0.08, coll="Porch")
for x in (-1.45, 1.45):
    K.box("Porch rail", (0.08, 1.1, 0.08), (x, PY - 1.0, 1.15), wood, "Porch", 0.01)
    for y in (PY - 0.55, PY - 0.8, PY - 1.05, PY - 1.3):
        K.box("Baluster", (0.045, 0.045, 0.85), (x, y, 0.3), trim, "Porch", 0.005)
# lantern by the door
K.box("Lantern", (0.18, 0.18, 0.26), (0.85, PY - 0.2, 2.35), flowers[0], "Porch", 0.01)
K.box("Lantern top", (0.26, 0.26, 0.06), (0.85, PY - 0.2, 2.61), wood, "Porch", 0.01)

# ---- garden ---------------------------------------------------------------
for i in range(4):
    for s in (-1, 1):
        K.box("Paver", (0.62, 0.42, 0.06), (s * 0.34, PY - 3.2 - i * 0.5, 0), random.choice(stone), "Garden", 0.04)
for x in (-4.2, 4.2):
    K.box("Flower bed", (1.2, 2.6, 0.22), (x, -2.3, 0), stone[1], "Garden", 0.05)
    for k in range(5):
        K.bush(f"Bed bush {x} {k}", (x + random.uniform(-0.25, 0.25), -3.4 + k * 0.55, 0.22), 0.32, leaves, "Garden", flowers)
K.tree("Tree A", (-4.7, 2.5, 0), 3.4, wood, leaves)
K.tree("Tree B", (4.8, 2.8, 0), 3.0, wood, leaves)
K.fence("Fence back", (-6.2, 5.1, 0), (6.2, 5.1, 0), 1.1, 0.34, trim, "Garden")
K.fence("Fence left", (-6.2, -3.4, 0), (-6.2, 5.1, 0), 1.1, 0.34, trim, "Garden")
K.fence("Fence right", (6.2, -3.4, 0), (6.2, 5.1, 0), 1.1, 0.34, trim, "Garden")
for i in range(14):
    K.sphere(f"Pebble {i}", 0.1, (random.choice((-1, 1)) * random.uniform(4.9, 5.6), random.uniform(-4.5, 3.5), 0.03), random.choice(stone), "Garden", 1, (1.2, 0.9, 0.6))

# ---- camera, lights, check, save, render ----------------------------------
K.camera(azimuth_deg=-38, elevation_deg=27, ortho=True, margin=1.05)
K.lights(sun_strength=3.8, world_strength=0.4)
K.finish(OUT, "cozy_house", description="Two-storey cottage diorama built with ofx_blender_kit. Units: metres. F12 to render.",
         preview=True, engine='EEVEE', samples=48, resolution=(1440, 1200), final=FINAL)
