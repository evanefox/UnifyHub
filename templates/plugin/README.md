# __PLUGIN_NAME__

Short description of what this plugin changes in Unity Hub.

## Files

- `plugin.json` is the manifest read by `src/unifyhub.mjs`.
- `patches/main.js.txt` is an example replacement payload.

## Manifest Fields

- `id`: stable plugin id. It must match `[a-z0-9][a-z0-9._-]{0,63}`.
- `name`, `version`, and `description`: shown in Plugin Manager.
- `core`: leave `false` for normal plugins. Core plugins cannot be disabled or uninstalled from the UI.
- `config`: optional Plugin Manager settings. Checkbox settings are stored in UnifyHub state and are shown through the Manage > Config dialog.
- `replacements`: patch operations applied to Unity Hub's `app.asar`.

Replacement entries support:

- `file`: exact path inside `app.asar`.
- `filePattern`: wildcard path inside `app.asar`, useful for hashed bundles such as `build/main/app-*.js`.
- `find`: source text anchor to replace.
- `replace`: inline replacement text.
- `replaceFromFile`: replacement payload relative to this plugin folder.
- `alreadyPatchedFind`: marker text that only exists after the patch, used to keep repeated builds safe.
- `once`: defaults to one replacement. Set `false` only when replacing every occurrence is intentional.
- `required`: defaults to required. Set `false` only for optional compatibility patches.

## Development Notes

1. Change `id`, `name`, `description`, and `version`.
2. Point each replacement at either `file` or `filePattern`.
3. Use a stable `find` anchor from the extracted Unity Hub ASAR.
4. Use `alreadyPatchedFind` so repeated builds are safe.
5. Set `required` to `false` only for optional compatibility patches.

Plugins created by `src\create-plugin.mjs` are placed under the repo `plugins\` folder. Those are bundled/development plugins, so Plugin Manager shows them with a `Bundled` chip and disables UI uninstall. Plugins installed through the Plugin Manager `Install plugin` button are copied into the per-install user plugin folder and can be uninstalled from the UI.

Build against the dummy target first:

```powershell
node src\unifyhub.mjs build --target dummy --plugins plugin-manager,__PLUGIN_ID__
```

Build against the real selected target only after the dummy build works:

```powershell
node src\unifyhub.mjs build --target auto --plugins plugin-manager,devtools,__PLUGIN_ID__
```
