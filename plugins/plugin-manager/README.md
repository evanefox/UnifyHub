# Plugin Manager UI

⚠️ **WARNING**: This is a core plugin. Do not remove, disable, or modify its patches. Doing so can cause UnifyHub to become unstable, crash, or corrupt your Unity Hub installation. Always restore and reinstall if you accidentally modify this plugin.

---

## Overview

This plugin injects the Plugins management page into Unity Hub's sidebar. It handles all plugin lifecycle operations: listing, installing, enabling, disabling, applying, and restoring.

## Key Files

| File | Purpose |
|------|---------|
| `plugin.json` | Declares the patch replacements |
| `patches/main-bridge.js.txt` | Main-process IPC handlers |
| `patches/preload-bridge.cjs.txt` | Renderer API bridge |
| `patches/unifyhub-plugin-manager.html` | Plugins page UI |

## Development

Test changes on the dummy target only:

```powershell
node src\unifyhub.mjs restore --target dummy
node src\unifyhub.mjs install --target dummy
node src\start-target.mjs --target dummy --remote-debugging-port=9333
```

Do not test directly on your real Unity Hub install.