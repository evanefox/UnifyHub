# Patch Payloads

Put replacement text files here. Keep them small and named after the target area they patch, for example:

- `main.js.txt`
- `preload.cjs.txt`
- `renderer.html`

The container reads these files through `replaceFromFile` in `plugin.json`.

Payload files should include a unique marker comment or function name that can be used by `alreadyPatchedFind`. That marker is what prevents a rebuild from applying the same patch twice.

When patching generated Unity Hub bundles, prefer stable function/class anchors over CSS hash names whenever possible. Hash names can change after Unity Hub updates.
