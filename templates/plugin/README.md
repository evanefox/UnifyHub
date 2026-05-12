# __PLUGIN_NAME__

Short description of what this plugin adds to Unity Hub.

## What This Plugin Contains

This template starts as a runtime plugin. Runtime plugins are the easy path: they are loaded by UnifyHub after Unity Hub starts, and they can use the UnifyHub plugin API instead of patching Unity Hub bundles directly.

```text
__PLUGIN_ID__/
  plugin.json
  runtime/
    renderer.js
    main.cjs
  patches/
    main.js.txt
```

## Components

| Component | Purpose |
| --- | --- |
| `plugin.json` | Plugin manifest. Defines identity, settings, runtime entry points, and optional ASAR replacements. |
| `runtime/renderer.js` | Renderer runtime entry. Use it for sidebar pages and UI behavior. |
| `runtime/main.cjs` | Main-process runtime entry. Use it for window/taskbar/native integrations exposed by UnifyHub. |
| `patches/` | Optional low-level replacement payloads for advanced plugins. |

## Runtime Entry Points

Runtime entries are declared in `plugin.json`:

```json
"runtime": {
  "renderer": "runtime/renderer.js",
  "main": "runtime/main.cjs"
}
```

Both files export a `start(ctx)` function.

## Renderer Example

`runtime/renderer.js` can add a page to the Unity Hub sidebar:

```js
module.exports.start = function start(ctx) {
  ctx.ui.addSidebarPage({
    id: "page",
    label: ctx.plugin.name,
    title: ctx.plugin.name,
    render() {
      return "<p>Hello from my plugin.</p>";
    }
  });
};
```

Useful renderer context:

| API | Purpose |
| --- | --- |
| `ctx.plugin` | Plugin id, name, version, and path metadata. |
| `ctx.config` | Config values loaded when the plugin starts. |
| `ctx.log(...)` | Log with a plugin prefix. |
| `ctx.ui.addSidebarPage(...)` | Add a page to Unity Hub's sidebar. |
| `ctx.settings.get(key, fallback)` | Read the latest saved plugin setting. |
| `ctx.settings.set(key, value)` | Save a plugin setting. |

## Main Example

`runtime/main.cjs` runs in Unity Hub's main Electron process:

```js
module.exports.start = function start(ctx) {
  ctx.log("main runtime loaded");
};
```

Useful main context:

| API | Purpose |
| --- | --- |
| `ctx.plugin` | Plugin id, name, version, and path metadata. |
| `ctx.config.get(key, fallback)` | Read saved plugin config. |
| `ctx.config.set(key, value)` | Save plugin config. |
| `ctx.window.focus()` | Bring Unity Hub to the front. |
| `ctx.taskbar.setProgress(value, options)` | Set Windows taskbar progress on the focused Unity Hub window. |
| `ctx.taskbar.clear()` | Clear taskbar progress. |
| `ctx.log(...)` | Log with a plugin prefix. |

## Settings

The `config` array creates controls in the Plugin Manager Config dialog.

```json
{
  "key": "enabledExample",
  "type": "checkbox",
  "label": "Example setting",
  "description": "Replace this with a setting the plugin actually uses.",
  "default": false
}
```

Use stable config keys. Saved user settings are tied to those keys.

## Optional Low-Level Patches

Most plugins should start with runtime APIs. Use `replacements` only when the runtime API cannot reach the behavior you need.

```json
{
  "filePattern": "build/main/app-*.js",
  "find": "TEXT_TO_FIND_IN_TARGET_FILE",
  "replaceFromFile": "patches/main.js.txt",
  "alreadyPatchedFind": "UNIFYHUB_PLUGIN_PATCH:__PLUGIN_ID__",
  "once": true,
  "required": true
}
```

Patch rules:

- `find` must be exact text that exists in the target file.
- `replaceFromFile` points to a payload under this plugin folder.
- `alreadyPatchedFind` must match a unique marker that exists after patching.
- `required: true` should be used when the plugin cannot work without that patch.
- `required: false` should only be used for optional compatibility patches.

## Notes

- Keep one plugin focused on one feature.
- Prefer runtime APIs over ASAR text replacements.
- Use patches only for missing APIs or deep Unity Hub internals.
- Put long technical explanations in project docs instead of this README.
