# -*- coding: utf-8 -*-
"""
ofx_blender_kit — a small, tested helper library for building presentable
low-poly scenes with bpy in Blender 4.2+ / 5.x (headless or GUI).

Why it exists: agents writing raw bpy keep making the same mistakes —
half-size cubes (primitive_cube_add(size=1) then scale=size/2), materials
that render fine but look grey in the viewport, scenes saved in Solid
shading, cameras that miss the model, and parts that float next to the
object they should touch. Everything here has explicit, documented size
semantics and there is a `check_scene()` that reports those geometry
mistakes as data.

Usage inside a build script (see example_cozy_house.py):

    import sys; sys.path.insert(0, r"<dir containing this file>")
    import ofx_blender_kit as K
    K.reset_scene()
    ...
    K.finish(out_dir, name="my_scene", preview=True)

Conventions
- Units are metres, +Z is up, ground is z=0.
- `box(size=(w, d, h), at=(x, y, z))`: size is the FULL extent; `at` is the
  bottom-centre unless `center=True`.
- `mat()` sets both the Principled BSDF base colour and `diffuse_color`, so
  Solid *and* Material Preview show the colour.
- Every object goes into a named collection so the outliner stays readable.
"""
import bpy
import math
import json
import os
import random
from mathutils import Vector

__version__ = "1.0.0"

_collections = {}
_materials = {}


# ---------------------------------------------------------------------------
# Scene setup
# ---------------------------------------------------------------------------

def reset_scene(keep_world=False):
    """Delete every object, mesh, material, light and camera. Call first."""
    global _collections, _materials
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.curves):
        for item in list(block):
            if item.users == 0:
                block.remove(item)
    if not keep_world:
        for w in list(bpy.data.worlds):
            bpy.data.worlds.remove(w)
    _collections = {}
    _materials = {}
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.length_unit = 'METERS'
    random.seed(7)
    return scene


def collection(name):
    """Get or create a top-level collection (e.g. '01 Walls')."""
    if name in _collections:
        return _collections[name]
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    _collections[name] = coll
    return coll


def _link(obj, coll_name):
    coll = collection(coll_name or "Objects")
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)
    return obj


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

def mat(name, color, roughness=0.6, metallic=0.0, emission=0.0):
    """Principled material. `color` is (r, g, b) in 0..1 or a '#rrggbb' string.
    Also sets diffuse_color so the colour is visible in Solid viewport shading."""
    if name in _materials:
        return _materials[name]
    if isinstance(color, str):
        color = hex_color(color)
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1.0)
    m.roughness = roughness
    m.metallic = metallic
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
        if emission > 0:
            bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
            bsdf.inputs["Emission Strength"].default_value = emission
    _materials[name] = m
    return m


def hex_color(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def shade(color, k):
    """Lighten (k>1) or darken (k<1) a colour, e.g. shade(base, 0.85)."""
    if isinstance(color, str):
        color = hex_color(color)
    return tuple(min(1.0, max(0.0, c * k)) for c in color)


def palette(name, color, n=4, spread=0.12, roughness=0.6):
    """n slightly different shades of one material, for tiles/stones/leaves."""
    return [mat(f"{name} {i}", shade(color, 1 - spread / 2 + spread * i / max(1, n - 1)), roughness) for i in range(n)]


# ---------------------------------------------------------------------------
# Primitives (all sizes are FULL extents)
# ---------------------------------------------------------------------------

def _finish_obj(obj, material, coll, bevel_width, name):
    obj.name = name
    if material is not None:
        obj.data.materials.append(material)
    _link(obj, coll)
    if bevel_width and bevel_width > 0:
        bevel(obj, bevel_width)
    return obj


def box(name, size, at, material=None, coll="Objects", bevel_width=0.0, center=False, rot=(0, 0, 0)):
    """Axis-aligned box. size=(w, d, h) full extents. at=bottom-centre unless center=True."""
    w, d, h = size
    x, y, z = at
    if not center:
        z = z + h / 2
    sx, sy, sz = w / 2, d / 2, h / 2
    verts = [(-sx, -sy, -sz), (-sx, -sy, sz), (-sx, sy, -sz), (-sx, sy, sz),
             (sx, -sy, -sz), (sx, -sy, sz), (sx, sy, -sz), (sx, sy, sz)]
    faces = [(0, 4, 6, 2), (1, 3, 7, 5), (0, 1, 5, 4), (2, 6, 7, 3), (0, 2, 3, 1), (4, 5, 7, 6)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    obj.location = (x, y, z)
    obj.rotation_euler = rot
    bpy.context.scene.collection.objects.link(obj)
    return _finish_obj(obj, material, coll, bevel_width, name)


def mesh(name, verts, faces, material=None, coll="Objects", bevel_width=0.0, solidify=0.0):
    """Arbitrary mesh from world-space vertices. solidify>0 adds thickness."""
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    _finish_obj(obj, material, coll, bevel_width, name)
    if solidify:
        m = obj.modifiers.new("Solidify", 'SOLIDIFY')
        m.thickness = solidify
        m.offset = 0.0
    return obj


def cylinder(name, radius, height, at, material=None, coll="Objects", vertices=16, bevel_width=0.0, axis='Z'):
    """Cylinder standing on `at` (bottom-centre) along Z, or centred at `at` for axis X/Y."""
    x, y, z = at
    loc = (x, y, z + height / 2) if axis == 'Z' else (x, y, z)
    rot = {'Z': (0, 0, 0), 'X': (0, math.pi / 2, 0), 'Y': (math.pi / 2, 0, 0)}[axis]
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=height, location=loc, rotation=rot)
    return _finish_obj(bpy.context.object, material, coll, bevel_width, name)


def sphere(name, radius, at, material=None, coll="Objects", subdivisions=2, scale=(1, 1, 1)):
    """Ico-sphere centred at `at`. scale squashes it (e.g. bushes)."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=radius, location=at)
    obj = bpy.context.object
    obj.scale = scale
    return _finish_obj(obj, material, coll, 0.0, name)


def cone(name, radius, height, at, material=None, coll="Objects", vertices=16, rot=(0, 0, 0)):
    """Cone standing on `at` (bottom-centre)."""
    x, y, z = at
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius, radius2=0, depth=height,
                                    location=(x, y, z + height / 2), rotation=rot)
    return _finish_obj(bpy.context.object, material, coll, 0.0, name)


def beam(name, a, b, thickness, material=None, coll="Objects", bevel_width=0.01):
    """Square-section beam from point a to point b (world coords)."""
    a, b = Vector(a), Vector(b)
    length = (b - a).length
    obj = box(name, (thickness, thickness, length), ((a + b) / 2), material, coll, bevel_width, center=True)
    obj.rotation_euler = (b - a).to_track_quat('Z', 'Y').to_euler()
    return obj


def bevel(obj, width=0.03, segments=3):
    m = obj.modifiers.new("Bevel", 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    return obj


def cut(target, cutter, remove_cutter=True):
    """Boolean-subtract `cutter` from `target` and apply it (real openings)."""
    m = target.modifiers.new("Cut", 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.object = cutter
    m.solver = 'EXACT'
    # apply through the object context
    prev_active = bpy.context.view_layer.objects.active
    bpy.context.view_layer.objects.active = target
    # keep bevels after the boolean
    while target.modifiers.find(m.name) > 0:
        bpy.ops.object.modifier_move_up(modifier=m.name)
    bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.context.view_layer.objects.active = prev_active
    if remove_cutter:
        bpy.data.objects.remove(cutter, do_unlink=True)
    return target


# ---------------------------------------------------------------------------
# Architecture parts
# ---------------------------------------------------------------------------

def gable_roof(name, width, depth, height, at, material=None, coll="Roof", overhang=0.4, thickness=0.12, ridge_axis='X'):
    """Pitched (gable) roof: triangular prism with its bottom rectangle at `at` (centre, z=eave height).
    width along the ridge axis, depth across it. Returns the roof object."""
    x, y, z = at
    w = width / 2 + overhang
    d = depth / 2 + overhang
    if ridge_axis == 'X':
        verts = [(-w, -d, z), (w, -d, z), (w, d, z), (-w, d, z), (-w, 0, z + height), (w, 0, z + height)]
    else:
        verts = [(-d, -w, z), (d, -w, z), (d, w, z), (-d, w, z), (0, -w, z + height), (0, w, z + height)]
    verts = [(vx + x, vy + y, vz) for vx, vy, vz in verts]
    faces = [(0, 1, 5, 4), (3, 2, 5, 4), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)] if ridge_axis == 'X' else \
            [(0, 1, 4), (3, 2, 5), (0, 4, 5, 3), (1, 2, 5, 4), (0, 3, 2, 1)]
    obj = mesh(name, verts, faces, material, coll, bevel_width=0.02)
    if thickness:
        m = obj.modifiers.new("Solidify", 'SOLIDIFY')
        m.thickness = thickness
        m.offset = 1.0
    return obj


def hip_roof(name, width, depth, height, at, material=None, coll="Roof", overhang=0.4, ridge_fraction=0.4):
    """Four-sided hip roof; ridge runs along X and is `ridge_fraction` of the width."""
    x, y, z = at
    w = width / 2 + overhang
    d = depth / 2 + overhang
    r = width * ridge_fraction / 2
    verts = [(-w, -d, z), (w, -d, z), (w, d, z), (-w, d, z), (-r, 0, z + height), (r, 0, z + height)]
    verts = [(vx + x, vy + y, vz) for vx, vy, vz in verts]
    faces = [(0, 1, 5, 4), (3, 2, 5, 4), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]
    obj = mesh(name, verts, faces, material, coll, bevel_width=0.02)
    m = obj.modifiers.new("Solidify", 'SOLIDIFY')
    m.thickness = 0.12
    m.offset = 1.0
    return obj


def roof_tiles(name, slope_a, slope_b, slope_c, slope_d, materials, rows=8, cols=12, thickness=0.04, lift=0.05, coll="Roof"):
    """Individual tiles over a quad slope (a,b = bottom edge, d,c = top edge, world coords).
    Gives the flat roof face a hand-made look; ~rows*cols objects."""
    a, b, c, d = Vector(slope_a), Vector(slope_b), Vector(slope_c), Vector(slope_d)
    up = ((b - a).cross(d - a)).normalized()
    if up.z < 0:
        up = -up
    for r in range(rows):
        t0, t1 = r / rows, min(1.0, (r + 1) / rows + 0.04)
        for k in range(cols):
            s0, s1 = k / cols, min(1.0, (k + 1) / cols + 0.03)
            def p(s, t):
                bottom = a.lerp(b, s)
                top = d.lerp(c, s)
                return bottom.lerp(top, t) + up * (lift + (rows - r) * 0.004)
            verts = [tuple(p(s0, t0)), tuple(p(s1, t0)), tuple(p(s1, t1)), tuple(p(s0, t1))]
            mesh(f"{name} r{r + 1:02d} c{k + 1:02d}", verts, [(0, 1, 2, 3)], random.choice(materials), coll,
                 bevel_width=0.008, solidify=thickness)


def window(name, wall_side, u, z, w=1.2, h=1.3, wall_center=(0, 0), wall_size=(8, 6), frame_mat=None, glass_mat=None,
           bar_mat=None, shutter_mat=None, sill_mat=None, coll="Windows", inset=0.03):
    """Window on the OUTSIDE of a box-shaped wall block.
    wall_side: 'front' (-Y), 'back' (+Y), 'left' (-X), 'right' (+X).
    u: position along the wall (x for front/back, y for left/right); z: sill height (bottom of frame).
    The frame is placed flush with the wall surface so it never floats."""
    cx, cy = wall_center
    ww, wd = wall_size
    frame_mat = frame_mat or mat("Window frame", "#f2eee4")
    glass_mat = glass_mat or mat("Window glass", "#7fb4c9", 0.15, 0.3)
    bar_mat = bar_mat or frame_mat
    fd = 0.12  # frame depth
    if wall_side in ('front', 'back'):
        sign = -1 if wall_side == 'front' else 1
        yface = cy + sign * wd / 2
        def place(nm, width, height, depth, du, dz, dout, material):
            return box(nm, (width, depth, height), (cx + u + du, yface + sign * (dout + depth / 2 - inset), z + dz), material, coll, 0.01)
    else:
        sign = -1 if wall_side == 'left' else 1
        xface = cx + sign * ww / 2
        def place(nm, width, height, depth, du, dz, dout, material):
            return box(nm, (depth, width, height), (xface + sign * (dout + depth / 2 - inset), cy + u + du, z + dz), material, coll, 0.01)
    place(f"{name} recess", w, h, fd, 0, 0, 0.0, mat("Window recess", "#1f2a2e"))
    place(f"{name} glass", w - 0.16, h - 0.16, 0.02, 0, 0.08, 0.02, glass_mat)
    place(f"{name} jamb L", 0.09, h + 0.12, fd + 0.02, -w / 2, -0.06, 0.0, frame_mat)
    place(f"{name} jamb R", 0.09, h + 0.12, fd + 0.02, w / 2, -0.06, 0.0, frame_mat)
    place(f"{name} head", w + 0.18, 0.09, fd + 0.02, 0, h, 0.0, frame_mat)
    place(f"{name} mullion", 0.05, h - 0.1, 0.06, 0, 0.05, 0.06, bar_mat)
    place(f"{name} transom", w - 0.12, 0.05, 0.06, 0, h / 2, 0.06, bar_mat)
    place(f"{name} sill", w + 0.3, 0.1, 0.25, 0, -0.1, 0.0, sill_mat or mat("Window sill", "#cfc7b8"))
    if shutter_mat:
        for s in (-1, 1):
            place(f"{name} shutter {'L' if s < 0 else 'R'}", 0.32, h + 0.08, 0.05, s * (w / 2 + 0.25), -0.04, 0.0, shutter_mat)


def door(name, wall_side, u, w=1.0, h=2.1, wall_center=(0, 0), wall_size=(8, 6), door_mat=None, frame_mat=None,
         knob_mat=None, coll="Doors", z=0.0):
    """Door flush with the outside face of a wall block; z = floor level of the door."""
    cx, cy = wall_center
    ww, wd = wall_size
    door_mat = door_mat or mat("Door wood", "#7a4a22", 0.5)
    frame_mat = frame_mat or mat("Door frame", "#f2eee4")
    knob_mat = knob_mat or mat("Brass", "#c8a24a", 0.3, 0.8)
    if wall_side in ('front', 'back'):
        sign = -1 if wall_side == 'front' else 1
        yface = cy + sign * wd / 2
        def place(nm, width, height, depth, du, dz, dout, material, bw=0.01):
            return box(nm, (width, depth, height), (cx + u + du, yface + sign * (dout + depth / 2 - 0.02), z + dz), material, coll, bw)
        knob = (cx + u + w * 0.35, yface + sign * 0.12, z + h * 0.48)
    else:
        sign = -1 if wall_side == 'left' else 1
        xface = cx + sign * ww / 2
        def place(nm, width, height, depth, du, dz, dout, material, bw=0.01):
            return box(nm, (depth, width, height), (xface + sign * (dout + depth / 2 - 0.02), cy + u + du, z + dz), material, coll, bw)
        knob = (xface + sign * 0.12, cy + u + w * 0.35, z + h * 0.48)
    place(f"{name} recess", w, h, 0.10, 0, 0, 0.0, mat("Door recess", "#1f2a2e"))
    place(f"{name} leaf", w - 0.1, h - 0.06, 0.06, 0, 0.0, 0.06, door_mat)
    for dz in (h * 0.2, h * 0.58):
        for du in (-w * 0.22, w * 0.22):
            place(f"{name} panel", w * 0.3, h * 0.26, 0.02, du, dz, 0.12, mat("Door panel", shade(door_mat.diffuse_color[:3], 0.8)))
    place(f"{name} jamb L", 0.1, h + 0.1, 0.16, -w / 2, 0, 0.0, frame_mat)
    place(f"{name} jamb R", 0.1, h + 0.1, 0.16, w / 2, 0, 0.0, frame_mat)
    place(f"{name} lintel", w + 0.2, 0.12, 0.16, 0, h, 0.0, frame_mat)
    sphere(f"{name} knob", 0.05, knob, knob_mat, coll)


def stairs(name, width, steps, step_h=0.16, step_d=0.32, at=(0, 0, 0), direction='-Y', material=None, coll="Porch"):
    """Steps descending away from `at` (top-back edge centre, floor level = at.z)."""
    x, y, z = at
    material = material or mat("Stone step", "#b9b2a4")
    for i in range(steps):
        top = z - i * step_h
        if direction == '-Y':
            box(f"{name} {i + 1}", (width, step_d, top - (z - steps * step_h)), (x, y - step_d / 2 - i * step_d, z - steps * step_h), material, coll, 0.02)
        elif direction == '+Y':
            box(f"{name} {i + 1}", (width, step_d, top - (z - steps * step_h)), (x, y + step_d / 2 + i * step_d, z - steps * step_h), material, coll, 0.02)
        elif direction == '-X':
            box(f"{name} {i + 1}", (step_d, width, top - (z - steps * step_h)), (x - step_d / 2 - i * step_d, y, z - steps * step_h), material, coll, 0.02)
        else:
            box(f"{name} {i + 1}", (step_d, width, top - (z - steps * step_h)), (x + step_d / 2 + i * step_d, y, z - steps * step_h), material, coll, 0.02)


def fence(name, a, b, height=1.1, spacing=0.32, post_mat=None, coll="Garden"):
    """Picket fence from a to b (ground points)."""
    post_mat = post_mat or mat("Fence white", "#f4f1ea")
    a, b = Vector(a), Vector(b)
    length = (b - a).length
    n = max(1, int(length / spacing))
    for i in range(n + 1):
        p = a.lerp(b, i / n)
        box(f"{name} picket {i}", (0.09, 0.09, height), (p.x, p.y, p.z), post_mat, coll, 0.01)
        cone(f"{name} cap {i}", 0.075, 0.12, (p.x, p.y, p.z + height), post_mat, coll, vertices=4, rot=(0, 0, math.pi / 4))
    for zf in (0.35, 0.75):
        beam(f"{name} rail {zf}", (a.x, a.y, a.z + zf * height), (b.x, b.y, b.z + zf * height), 0.06, post_mat, coll)


def tree(name, at, height=3.0, trunk_mat=None, leaf_mats=None, coll="Garden"):
    """Low-poly tree: trunk + 4 leaf clusters."""
    x, y, z = at
    trunk_mat = trunk_mat or mat("Bark", "#5b3a1e", 0.8)
    leaf_mats = leaf_mats or palette("Leaf", "#5f9a3c", 4, 0.25)
    cylinder(f"{name} trunk", 0.09 * height / 3, height * 0.42, (x, y, z), trunk_mat, coll, 10)
    crown = height * 0.5
    # big overlapping clusters so the crown reads as one canopy, not scattered balls
    for i, (dx, dy, dz, s) in enumerate([(0, 0, 0.6, 0.72), (-0.16, 0.06, 0.52, 0.5), (0.15, 0.1, 0.55, 0.5), (0.02, -0.17, 0.5, 0.46), (0, 0, 0.82, 0.48)]):
        sphere(f"{name} crown {i}", crown * s, (x + dx * height, y + dy * height, z + height * dz), random.choice(leaf_mats), coll,
               subdivisions=1, scale=(1, 1, 0.85))


def bush(name, at, radius=0.4, leaf_mats=None, coll="Garden", flowers=None):
    leaf_mats = leaf_mats or palette("Leaf", "#5f9a3c", 4, 0.25)
    x, y, z = at
    for i in range(4):
        sphere(f"{name} {i}", radius * random.uniform(0.6, 1.0), (x + random.uniform(-radius, radius) * 0.6, y + random.uniform(-radius, radius) * 0.6, z + radius * 0.6),
               random.choice(leaf_mats), coll, 1, (1, 1, 0.8))
    if flowers:
        for i in range(5):
            sphere(f"{name} flower {i}", radius * 0.14, (x + random.uniform(-radius, radius) * 0.7, y + random.uniform(-radius, radius) * 0.7, z + radius * 1.05),
                   random.choice(flowers), coll, 1)


def ground(name, size, at=(0, 0, 0), material=None, thickness=0.3, edge_mat=None, coll="Ground"):
    """Diorama base: a slab whose TOP is at at.z (so the model sits on z=at.z)."""
    x, y, z = at
    w, d = size
    material = material or mat("Grass", "#8bb85a")
    edge_mat = edge_mat or mat("Earth", "#8a6a48")
    box(f"{name} earth", (w, d, thickness * 0.75), (x, y, z - thickness), edge_mat, coll, 0.06)
    return box(f"{name} top", (w - 0.05, d - 0.05, thickness * 0.3), (x, y, z - thickness * 0.3), material, coll, 0.05)


# ---------------------------------------------------------------------------
# Camera, light, render, save
# ---------------------------------------------------------------------------

def scene_bounds(exclude_collections=("Ground", "Backdrop", "Lighting")):
    """Axis-aligned bounds of all mesh objects (world space), excluding ground/backdrop."""
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    found = False
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        if any(c.name in exclude_collections for c in obj.users_collection):
            continue
        for corner in obj.bound_box:
            p = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
            hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
            found = True
    if not found:
        return Vector((-1, -1, 0)), Vector((1, 1, 1))
    return lo, hi


def camera(name="Camera", azimuth_deg=-35, elevation_deg=28, ortho=False, margin=1.25, target=None, coll="Lighting"):
    """Three-quarter camera automatically framed on the scene bounds. Returns the camera."""
    lo, hi = scene_bounds()
    center = target and Vector(target) or (lo + hi) / 2
    radius = max((hi - lo).length / 2, 1.0)
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    direction = Vector((math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el)))
    bpy.ops.object.camera_add(location=center + direction * radius * 3.2 * margin)
    cam = bpy.context.object
    cam.name = name
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 50
    cam.data.clip_end = 1000
    if ortho:
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = radius * 2.1 * margin
    _link(cam, coll)
    bpy.context.scene.camera = cam
    return cam


def lights(sun_strength=3.0, warm=True, coll="Lighting", world_color=(0.75, 0.82, 0.92), world_strength=0.6):
    """Sun key light + soft fill + sky world. Good enough for previews and finals."""
    scene = bpy.context.scene
    lo, hi = scene_bounds()
    center = (lo + hi) / 2
    size = max((hi - lo).length, 4)
    bpy.ops.object.light_add(type='SUN', location=center + Vector((-size, -size, size * 1.5)))
    sun = bpy.context.object
    sun.name = "Sun key"
    sun.data.energy = sun_strength
    sun.data.angle = math.radians(4)
    sun.data.color = (1.0, 0.93, 0.82) if warm else (1, 1, 1)
    sun.rotation_euler = (center - sun.location).to_track_quat('-Z', 'Y').to_euler()
    _link(sun, coll)
    bpy.ops.object.light_add(type='AREA', location=center + Vector((size, -size * 0.5, size)))
    fill = bpy.context.object
    fill.name = "Fill"
    fill.data.energy = 220 * (size / 10) ** 2
    fill.data.size = size
    fill.data.color = (0.8, 0.88, 1.0)
    fill.rotation_euler = (center - fill.location).to_track_quat('-Z', 'Y').to_euler()
    _link(fill, coll)
    world = bpy.data.worlds.new("Sky")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (*world_color, 1)
        bg.inputs[1].default_value = world_strength
    return sun, fill


def backdrop(size=200, material=None):
    """Large neutral floor so renders have no black void around the diorama."""
    material = material or mat("Backdrop", "#b9b5ac", 0.9)
    return box("Backdrop", (size, size, 0.05), (0, 0, -0.35), material, "Backdrop")


def set_render(engine='AUTO', samples=32, resolution=(1280, 960), filepath=None, transparent=False):
    """engine: 'EEVEE' (fast previews), 'CYCLES' (finals), 'AUTO' = EEVEE."""
    scene = bpy.context.scene
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    if engine == 'CYCLES' and 'CYCLES' in engines:
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        try:
            scene.cycles.device = 'GPU'
        except Exception:
            pass
    else:
        scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in engines else 'BLENDER_EEVEE'
        try:
            scene.eevee.taa_render_samples = samples
        except Exception:
            pass
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = transparent
    # 'Standard' keeps low-poly diorama colours punchy; AgX/Filmic wash pastel palettes out.
    try:
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.look = 'None'
    except Exception:
        pass
    try:  # EEVEE Next: soft shadows + a little ray-traced bounce so walls are not flat
        scene.eevee.use_shadows = True
        scene.eevee.use_raytracing = True
    except Exception:
        pass
    if filepath:
        scene.render.filepath = filepath
    return scene


def render(filepath, engine='EEVEE', samples=32, resolution=(1280, 960)):
    """Render a still to `filepath` and return the path."""
    set_render(engine, samples, resolution, filepath)
    bpy.ops.render.render(write_still=True)
    return filepath


def set_viewport_material_preview(hide_floor_grid=False, look_through_camera=True):
    """Make the saved .blend open in Material Preview so colours show immediately."""
    cam = bpy.context.scene.camera
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != 'VIEW_3D':
                continue
            for space in area.spaces:
                if space.type != 'VIEW_3D':
                    continue
                space.shading.type = 'MATERIAL'
                space.overlay.show_floor = not hide_floor_grid
                if look_through_camera and cam:
                    space.region_3d.view_perspective = 'CAMERA'


def save(filepath, description=""):
    """Save the .blend (no .blend1 backups) with viewport in Material Preview."""
    set_viewport_material_preview()
    if description:
        bpy.context.scene["Description"] = description
        txt = bpy.data.texts.get("README") or bpy.data.texts.new("README")
        txt.clear()
        txt.write(description)
    bpy.context.preferences.filepaths.save_version = 0
    os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(filepath))
    return filepath


# ---------------------------------------------------------------------------
# Structural self-check
# ---------------------------------------------------------------------------

def _bbox(obj):
    pts = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def _overlaps(a, b, tol=0.02):
    (alo, ahi), (blo, bhi) = a, b
    return all(ahi[i] + tol >= blo[i] and bhi[i] + tol >= alo[i] for i in range(3))


def check_scene(ground_z=0.0, ignore_collections=("Lighting", "Backdrop", "Ground"), max_report=25):
    """Report geometry problems as data: parts floating above the ground with no
    neighbour touching them, and the object count per collection. Print the result
    and READ it before rendering — a floating window or a roof with a gap under it
    shows up here as `floating`."""
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH'
            and not any(c.name in ignore_collections for c in o.users_collection)]
    boxes = {o.name: _bbox(o) for o in objs}
    floating = []
    below_ground = []
    for o in objs:
        lo, hi = boxes[o.name]
        if lo.z < ground_z - 0.05:
            below_ground.append(o.name)
        if lo.z <= ground_z + 0.05:
            continue  # rests on the ground
        touching = any(n != o.name and _overlaps(boxes[o.name], boxes[n]) for n in boxes)
        if not touching:
            floating.append({"object": o.name, "bottom_z": round(lo.z, 3), "center": [round(v, 2) for v in ((lo + hi) / 2)]})
    per_coll = {}
    for o in objs:
        for c in o.users_collection:
            per_coll[c.name] = per_coll.get(c.name, 0) + 1
    lo, hi = scene_bounds()
    report = {
        "objects": len(objs),
        "collections": per_coll,
        "bounds_m": {"min": [round(v, 2) for v in lo], "max": [round(v, 2) for v in hi]},
        "floating_unattached": floating[:max_report],
        "floating_count": len(floating),
        "below_ground": below_ground[:max_report],
        "has_camera": bpy.context.scene.camera is not None,
        "materials_with_viewport_color": sum(1 for m in bpy.data.materials if m.users and tuple(m.diffuse_color[:3]) != (0.8, 0.8, 0.8)),
        "materials": sum(1 for m in bpy.data.materials if m.users),
    }
    print("OFX_SCENE_CHECK " + json.dumps(report, ensure_ascii=False))
    return report


def finish(out_dir, name, description="", preview=True, engine='EEVEE', samples=32, resolution=(1280, 960), final=False):
    """Standard ending: camera+lights if missing → check_scene → save .blend → preview render.
    Returns dict of produced paths. Set final=True for a Cycles render at higher samples."""
    os.makedirs(out_dir, exist_ok=True)
    if bpy.context.scene.camera is None:
        camera()
    if not any(o.type == 'LIGHT' for o in bpy.context.scene.objects):
        lights()
    report = check_scene()
    blend = save(os.path.join(out_dir, f"{name}.blend"), description)
    out = {"blend": blend, "check": report}
    if preview:
        out["preview"] = render(os.path.join(out_dir, f"{name}_preview.png"), engine, samples, resolution)
    if final:
        out["final"] = render(os.path.join(out_dir, f"{name}_final.png"), 'CYCLES', max(samples, 64), (1600, 1200))
    print("OFX_DONE " + json.dumps({k: v for k, v in out.items() if k != 'check'}, ensure_ascii=False))
    return out
