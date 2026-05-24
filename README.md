<p align="center">
<img width="100" height="100" alt="UnifyHub_Logo" src="https://github.com/user-attachments/assets/ea1130f8-a151-4bda-bc71-bdfb6a1e6526" />
</p>

<h1 align="center">UnifyHub</h1>



An open-source plugin framework for expanding, enhancing, and customizing Unity Hub.

## Features

- **Easy to install**
- **Built-in Plugin Manager**
- **Lightweight Patch Model**
- **Privacy Friendly**: no UnifyHub telemetry, accounts, analytics, or remote config. It only works with local files and Unity Hub's local process.
- **Plugin Template Included**: scaffold a new plugin from `templates/plugin` with one command.

## Included Plugins

UnifyHub currently ships with:

- `plugin-manager`: the in-app Plugins page.
- `devtools`: optional debug and window tweaks.
- `taskbar-progress`: Windows taskbar progress and Editor install notification support.

## Install

Run the interactive installer:

```bat
unifyhub.bat
```

Or apply directly to the auto-detected Unity Hub install:

```bat
unifyhub.bat apply
```

UnifyHub will:

1. Detect Unity Hub.
2. Create or reuse a clean backup.
3. Build a patched `app.asar` from enabled plugins.
4. Install it into Unity Hub.
5. Relaunch Unity Hub when finished.

Administrator permission may be required because Unity Hub is usually installed under `C:\Program Files`.

## Commands

```bat
unifyhub.bat status
unifyhub.bat paths
unifyhub.bat plugins
unifyhub.bat apply
unifyhub.bat restore
unifyhub.bat doctor
```

Enable or disable a plugin:

```bat
unifyhub.bat enable devtools
unifyhub.bat disable devtools
```

View or change plugin config:

```bat
unifyhub.bat config devtools
unifyhub.bat config devtools enableRightClickInspect false
```

## Create A Plugin

Create a new plugin from the template:

```bat
node src\create-plugin.mjs my-plugin --name "My Plugin"
```

Then edit:

```text
plugins\my-plugin\plugin.json
plugins\my-plugin\patches\main.js.txt
```

Build it with:

```bat
unifyhub.bat apply --plugins plugin-manager,devtools,my-plugin
```

The template documents supported manifest fields such as `filePattern`, `find`, `replaceFromFile`, `alreadyPatchedFind`, config checkboxes, and optional compatibility patches.

## Disclaimer

Unity Hub is a trademark of Unity Technologies and is referenced only for descriptive purposes. UnifyHub is an unofficial open-source project and is not affiliated with, endorsed by, or supported by Unity Technologies.

<details>
<summary><strong>UnifyHub modifies the Unity Hub client, which may violate Unity's Terms of Service.</strong></summary>

UnifyHub does not bypass licensing, paid features, authentication systems, or account restrictions. Its purpose is limited to client customization, UX improvements, and plugin-based enhancements.

However, this does not guarantee safety. Avoid installing untrusted plugins or plugins designed for abusive behavior.

All official built-in UnifyHub plugins are intended for safe client-side enhancements only.

If your Unity account is business-critical or losing access would create serious problems, do not use client modifications.

Be cautious when sharing screenshots, recordings, or support requests that visibly show UnifyHub modifications.

Use UnifyHub at your own risk. The maintainers are not responsible for account restrictions, data loss, or any damages resulting from its use.

</details>
