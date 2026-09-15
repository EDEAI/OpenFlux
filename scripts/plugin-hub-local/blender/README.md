# Blender plugin (OpenFlux)

Skill plugin that teaches the agent a reliable Blender workflow and ships a tested
bpy helper library.

- `skills/blender-modeling/SKILL.md` — the workflow, checklist and kit API.
- `skills/blender-modeling/scripts/ofx_blender_kit.py` — helper library (Blender 4.2+ / 5.x).
- `skills/blender-modeling/scripts/example_cozy_house.py` — reference scene (two-storey cottage diorama, ~840 parts).

Try it headless:

```
blender --background --factory-startup --python skills/blender-modeling/scripts/example_cozy_house.py -- --out out
```

Requires Blender installed on the machine running the agent.
