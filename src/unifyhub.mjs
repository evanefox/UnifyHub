import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupIfNeeded, createPatchedAsar, ensureFreshBackup, installAsar, restoreAsar } from './container.mjs';
import { targetDataDir, targetPluginsDir, targetStatePath } from './paths.mjs';
import { resolveTarget, targets } from './targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundledPluginsDir = join(root, 'plugins');
const defaultPluginIds = ['plugin-manager'];
const corePluginIds = new Set(['plugin-manager']);
const defaultEnabledPluginIds = new Set(defaultPluginIds);
const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function parseArgs(argv) {
  const args = {
    command: argv[2] || 'help',
    positionals: [],
    pluginIds: [],
    targetId: process.env.UNIFYHUB_TARGET || 'auto',
    json: false,
    quiet: false,
    noStart: false,
  };
  if (args.command === '--help' || args.command === '-h') args.command = 'help';
  if (args.command === '--version' || args.command === '-v') args.command = 'version';

  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plugins') {
      args.pluginIds = argv[index + 1].split(',').map((item) => item.trim()).filter(Boolean);
      index += 1;
    } else if (arg === '--target') {
      args.targetId = argv[index + 1];
      index += 1;
    } else if (arg === '--source') {
      args.sourcePath = argv[index + 1];
      index += 1;
    } else if (arg === '--output') {
      args.outputPath = argv[index + 1];
      index += 1;
    } else if (arg === '--backup') {
      args.backupPath = argv[index + 1];
      index += 1;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--quiet' || arg === '-q') {
      args.quiet = true;
    } else if (arg === '--no-start' || arg === '--no-restart') {
      args.noStart = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--version' || arg === '-v') {
      args.command = 'version';
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.positionals.push(arg);
    }
  }
  return args;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse((await readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readManifest(pluginDir, source) {
  const manifestPath = join(pluginDir, 'plugin.json');
  const manifest = await readJson(manifestPath, null);
  if (!manifest?.id) throw new Error(`Invalid plugin manifest: ${manifestPath}`);
  if (!pluginIdPattern.test(manifest.id)) throw new Error(`Invalid plugin id in ${manifestPath}: ${manifest.id}`);
  return {
    ...manifest,
    manifestPath,
    pluginDir,
    source,
    bundled: source === 'bundled',
    core: Boolean(manifest.core || corePluginIds.has(manifest.id)),
  };
}

async function readState(target) {
  const statePath = targetStatePath(target);
  const legacyStatePath = join(root, 'state', `${target.id || 'real'}.json`);
  const state = await readJson(statePath, await readJson(legacyStatePath, {
    enabled: { 'plugin-manager': true },
    config: {},
    disabledByUser: {},
  }));
  state.enabled ||= {};
  state.config ||= {};
  state.disabledByUser ||= {};
  state.enabled['plugin-manager'] = true;
  return state;
}

async function writeState(target, state) {
  state.enabled ||= {};
  state.config ||= {};
  state.disabledByUser ||= {};
  state.enabled['plugin-manager'] = true;
  await writeJson(targetStatePath(target), state);
}

async function listPluginDir(dir, source) {
  if (!await exists(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      plugins.push(await readManifest(join(dir, entry.name), source));
    } catch {
      // Ignore folders that are not UnifyHub plugins.
    }
  }
  return plugins;
}

async function listAvailablePlugins(target) {
  await mkdir(targetPluginsDir(target), { recursive: true });
  const state = await readState(target);
  const merged = new Map();
  for (const plugin of await listPluginDir(bundledPluginsDir, 'bundled')) merged.set(plugin.id, plugin);
  for (const plugin of await listPluginDir(targetPluginsDir(target), 'user')) {
    if (!merged.has(plugin.id)) merged.set(plugin.id, plugin);
  }
  return [...merged.values()]
    .map((plugin) => ({
      id: plugin.id,
      name: plugin.name || plugin.id,
      version: plugin.version || '',
      description: plugin.description || '',
      config: Array.isArray(plugin.config)
        ? plugin.config.map((item) => ({ ...item, value: state.config?.[plugin.id]?.[item.key] ?? item.default ?? false }))
        : [],
      core: plugin.core,
      bundled: plugin.bundled,
      source: plugin.source,
      enabled: plugin.core
        ? true
        : state.disabledByUser[plugin.id] === true
          ? false
          : defaultEnabledPluginIds.has(plugin.id) || Boolean(state.enabled[plugin.id]),
      path: plugin.pluginDir,
      manifestPath: plugin.manifestPath,
    }))
    .sort((a, b) => Number(b.core) - Number(a.core) || a.id.localeCompare(b.id));
}

async function loadPlugin(pluginId, target) {
  const bundledDir = join(bundledPluginsDir, pluginId);
  if (await exists(join(bundledDir, 'plugin.json'))) return readManifest(bundledDir, 'bundled');
  const userDir = join(targetPluginsDir(target), pluginId);
  if (await exists(join(userDir, 'plugin.json'))) return readManifest(userDir, 'user');
  throw new Error(`Unknown plugin: ${pluginId}`);
}

async function enabledPluginIds(target) {
  const plugins = await listAvailablePlugins(target);
  const ids = plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id);
  if (!ids.includes('plugin-manager')) ids.unshift('plugin-manager');
  return [...new Set(ids)];
}

async function selectedPluginIds(args, target) {
  return args.pluginIds.length ? args.pluginIds : enabledPluginIds(target);
}

async function loadSelectedPlugins(args, target) {
  return Promise.all((await selectedPluginIds(args, target)).map((pluginId) => loadPlugin(pluginId, target)));
}

function pathsFor(target) {
  return {
    projectRoot: root,
    targetRoot: target.rootPath,
    exePath: target.exePath,
    asarPath: target.asarPath,
    backupPath: target.backupPath,
    dataDir: targetDataDir(target),
    pluginsDir: targetPluginsDir(target),
    statePath: targetStatePath(target),
  };
}

function boolFromCli(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled', 'enable'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', 'disable'].includes(text)) return false;
  throw new Error(`Expected boolean value, got: ${value}`);
}

function printHelp() {
  console.log(`UnifyHub CLI

Usage:
  unifyhub <command> [options]

Core commands:
  backup                 Create the clean app.asar backup if missing
  build                  Build a patched ASAR in dist
  apply, install         Backup if needed, build, then install into target
  restore, uninstall     Restore original app.asar from backup
  auto                   Apply, then start Unity Hub
  start                  Start the selected Unity Hub target

Management:
  status                 Show target, paths, backup, and enabled plugins
  paths [name]           Show project/data/plugin/state/target paths
  plugins                List bundled and user plugins
  enable <plugin>        Enable a plugin in central state
  disable <plugin>       Disable a plugin in central state
  config                 Show plugin config state
  config <plugin>        Show one plugin's config
  config <plugin> <key> <value>
                         Set one config value
  install-plugin <dir>   Copy a plugin folder into the central plugin store
  doctor                 Check target files, backup, and writable data folders
  list                   JSON-compatible target/plugin/path listing
  version                Print UnifyHub version

Options:
  --target auto|dev      Target to operate on. Default: auto-detected Unity Hub
  --plugins a,b,c        Plugin ids to compose. Default: enabled plugins
  --source <path>        Override source app.asar
  --output <path>        Override patched ASAR output path
  --backup <path>        Override backup app.asar path
  --json                 Machine-readable output where supported
  --quiet, -q            Reduce output
  --no-start             Do not launch after auto

Examples:
  .\\unifyhub.ps1 status
  .\\unifyhub.ps1 paths plugins
  .\\unifyhub.ps1 dev build
  .\\unifyhub.ps1 config devtools enableRightClickInspect false
  .\\unifyhub.ps1 apply
  .\\unifyhub.ps1 auto
`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printPluginTable(plugins) {
  for (const plugin of plugins) {
    const state = plugin.enabled ? 'enabled ' : 'disabled';
    const source = plugin.core ? 'core' : plugin.source;
    const version = plugin.version ? ` ${plugin.version}` : '';
    console.log(`${state}  ${plugin.id}${version}  (${source})`);
    console.log(`          ${plugin.path}`);
  }
}

async function commandStatus(args, target) {
  const paths = pathsFor(target);
  const plugins = await listAvailablePlugins(target);
  const status = {
    target: target.id,
    name: target.name,
    paths,
    exists: {
      exe: await exists(paths.exePath),
      asar: await exists(paths.asarPath),
      backup: await exists(paths.backupPath),
      dataDir: await exists(paths.dataDir),
    },
    plugins,
  };
  if (args.json) return printJson(status);
  console.log(`Target:  ${status.name}`);
  console.log(`Root:    ${paths.targetRoot}`);
  console.log(`ASAR:    ${paths.asarPath} (${status.exists.asar ? 'found' : 'missing'})`);
  console.log(`Backup:  ${paths.backupPath} (${status.exists.backup ? 'found' : 'missing'})`);
  console.log(`Data:    ${paths.dataDir}`);
  console.log(`Plugins: ${(await enabledPluginIds(target)).join(', ')}`);
}

async function commandPaths(args, target) {
  const paths = pathsFor(target);
  const aliases = {
    project: 'projectRoot',
    data: 'dataDir',
    plugins: 'pluginsDir',
    state: 'statePath',
    target: 'targetRoot',
    exe: 'exePath',
    asar: 'asarPath',
    backup: 'backupPath',
  };
  const key = args.positionals[0];
  if (key) {
    const resolved = paths[aliases[key] || key];
    if (!resolved) throw new Error(`Unknown path name: ${key}`);
    console.log(resolved);
    return;
  }
  if (args.json) return printJson(paths);
  for (const [name, value] of Object.entries(paths)) console.log(`${name}: ${value}`);
}

async function commandPlugins(args, target) {
  const plugins = await listAvailablePlugins(target);
  if (args.json) return printJson({ target: target.id, plugins });
  printPluginTable(plugins);
}

async function commandSetPluginEnabled(args, target, enabled) {
  const pluginId = args.positionals[0];
  if (!pluginId) throw new Error(`${enabled ? 'enable' : 'disable'} needs a plugin id.`);
  const plugin = await loadPlugin(pluginId, target);
  if (plugin.core && !enabled) throw new Error(`${pluginId} is a core plugin and cannot be disabled.`);
  const state = await readState(target);
  state.enabled[plugin.id] = Boolean(enabled);
  state.disabledByUser ||= {};
  if (enabled) delete state.disabledByUser[plugin.id];
  else state.disabledByUser[plugin.id] = true;
  await writeState(target, state);
  if (!args.quiet) console.log(`${plugin.id} ${enabled ? 'enabled' : 'disabled'}. Run apply to rebuild Unity Hub.`);
}

async function commandConfig(args, target) {
  const [pluginId, key, value] = args.positionals;
  const state = await readState(target);
  if (!pluginId) {
    if (args.json) return printJson(state.config || {});
    console.log(JSON.stringify(state.config || {}, null, 2));
    return;
  }
  const plugin = await loadPlugin(pluginId, target);
  const schema = Array.isArray(plugin.config) ? plugin.config : [];
  const allowed = new Set(schema.map((item) => item.key));
  state.config ||= {};
  state.config[plugin.id] ||= {};
  for (const item of schema) {
    if (!Object.prototype.hasOwnProperty.call(state.config[plugin.id], item.key)) {
      state.config[plugin.id][item.key] = item.default ?? false;
    }
  }
  if (!key) {
    const result = schema.map((item) => ({ ...item, value: state.config[plugin.id][item.key] }));
    if (args.json) return printJson({ plugin: plugin.id, config: result });
    for (const item of result) console.log(`${item.key}: ${item.value}  ${item.label || ''}`);
    return;
  }
  if (!allowed.has(key)) throw new Error(`${plugin.id} has no config key: ${key}`);
  if (typeof value === 'undefined') {
    console.log(String(state.config[plugin.id][key]));
    return;
  }
  const configItem = schema.find((item) => item.key === key);
  state.config[plugin.id][key] = configItem?.type === 'checkbox' ? boolFromCli(value) : value;
  await writeState(target, state);
  if (!args.quiet) console.log(`${plugin.id}.${key} = ${state.config[plugin.id][key]}. Run apply to rebuild Unity Hub.`);
}

async function commandInstallPlugin(args, target) {
  const sourceDir = args.positionals[0];
  if (!sourceDir) throw new Error('install-plugin needs a plugin folder path.');
  const manifest = await readManifest(resolve(sourceDir), 'source');
  if (!pluginIdPattern.test(manifest.id)) throw new Error(`Invalid plugin id: ${manifest.id}`);
  if (await exists(join(bundledPluginsDir, manifest.id, 'plugin.json'))) {
    throw new Error(`Plugin id is reserved by a bundled UnifyHub plugin: ${manifest.id}`);
  }
  const destination = join(targetPluginsDir(target), manifest.id);
  if (await exists(destination)) throw new Error(`Plugin already exists: ${manifest.id}`);
  await mkdir(targetPluginsDir(target), { recursive: true });
  await cp(resolve(sourceDir), destination, { recursive: true });
  const state = await readState(target);
  state.enabled[manifest.id] = true;
  state.disabledByUser ||= {};
  delete state.disabledByUser[manifest.id];
  await writeState(target, state);
  if (!args.quiet) console.log(`Installed ${manifest.id} to ${destination}`);
}

async function commandBackup(args, target, sourcePath, backupPath) {
  const backup = await ensureFreshBackup(sourcePath, backupPath);
  if (args.json) return printJson({ command: 'backup', target: target.id, sourcePath, backupPath, ...backup });
  if (!args.quiet) {
    if (backup.backupCreated) console.log(`Backup created: ${backupPath}`);
    else if (backup.backupRefreshed) console.log(`Backup refreshed: ${backup.reason}`);
    else console.log(`Backup already current: ${backupPath}`);
  }
}

async function commandBuild(args, target, sourcePath, outputPath, context) {
  const plugins = await loadSelectedPlugins(args, target);
  const result = await createPatchedAsar({ sourcePath, outputPath, plugins, context });
  if (args.json) return printJson({ command: 'build', target: target.id, sourcePath, outputPath, ...result });
  if (!args.quiet) {
    console.log(`Built ${outputPath}`);
    for (const item of result.results) console.log(`  ${item.status}: ${item.plugin} -> ${item.file}`);
  }
  return result;
}

async function commandApply(args, target, sourcePath, outputPath, backupPath, context) {
  await mkdir(targetPluginsDir(target), { recursive: true });
  await mkdir(targetDataDir(target), { recursive: true });
  const backup = await ensureFreshBackup(sourcePath, backupPath);
  const buildSourcePath = args.sourcePath ? sourcePath : backupPath;
  const plugins = await loadSelectedPlugins(args, target);
  const result = await createPatchedAsar({ sourcePath: buildSourcePath, outputPath, plugins, context });
  await installAsar(sourcePath, outputPath);
  const output = { command: 'apply', target: target.id, sourcePath, buildSourcePath, backupPath, ...backup, outputPath, ...result };
  if (args.json) return printJson(output);
  if (!args.quiet) {
    console.log(`Applied ${result.plugins.join(', ')} to ${target.name}`);
    if (backup.backupRefreshed) console.log(`Backup refreshed: ${backup.reason}`);
    console.log(`Data: ${targetDataDir(target)}`);
  }
  return output;
}

async function commandRestore(args, target, sourcePath, backupPath) {
  await restoreAsar(sourcePath, backupPath);
  if (args.json) return printJson({ command: 'restore', target: target.id, restoredFrom: backupPath, restoredTo: sourcePath });
  if (!args.quiet) console.log(`Restored ${target.name} from ${backupPath}`);
}

function commandStart(args, target) {
  if (!existsSync(target.exePath)) throw new Error(`Unity Hub executable not found: ${target.exePath}`);
  const extraArgs = args.positionals;
  const child = spawn(target.exePath, extraArgs, {
    cwd: target.rootPath,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      UNIFYHUB_HOME: root,
      UNIFYHUB_TARGET: target.id,
      UNIFYHUB_TARGET_ROOT: target.rootPath,
    },
  });
  child.unref();
  if (!args.quiet) console.log(`Started ${target.name} pid ${child.pid}`);
}

async function commandDoctor(args, target) {
  const paths = pathsFor(target);
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.pluginsDir, { recursive: true });
  const checks = {
    node: true,
    projectRoot: await exists(join(root, 'src', 'unifyhub.mjs')),
    targetExe: await exists(paths.exePath),
    targetAsar: await exists(paths.asarPath),
    backup: await exists(paths.backupPath),
    bundledPlugins: await exists(bundledPluginsDir),
    dataWritable: false,
  };
  try {
    const probe = join(paths.dataDir, `.unifyhub-probe-${Date.now()}.tmp`);
    await writeFile(probe, 'ok');
    await unlink(probe);
    checks.dataWritable = true;
  } catch {
    checks.dataWritable = false;
  }
  if (args.json) return printJson({ target: target.id, paths, checks });
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'OK ' : 'BAD'} ${name}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.command === 'help') return printHelp();

  const packageJson = await readJson(join(root, 'package.json'), { version: '0.0.0' });
  if (args.command === 'version') {
    console.log(packageJson.version || '0.0.0');
    return;
  }

  const target = resolveTarget(args.targetId);
  const effectiveTarget = process.env.UNIFYHUB_TARGET_ROOT ? { ...target, rootPath: process.env.UNIFYHUB_TARGET_ROOT } : target;
  const pluginIdsForOutput = args.pluginIds.length ? args.pluginIds : await enabledPluginIds(effectiveTarget);
  const sourcePath = args.sourcePath || process.env.UNITY_HUB_ASAR || target.asarPath;
  const outputPath = args.outputPath || process.env.UNIFYHUB_PATCHED_ASAR || join(root, 'dist', target.id, `app.asar.${pluginIdsForOutput.join('+')}`);
  const backupPath = args.backupPath || process.env.UNIFYHUB_BACKUP_ASAR || target.backupPath;
  const buildContext = {
    projectRoot: root,
    targetId: target.id,
    targetRoot: effectiveTarget.rootPath,
  };

  switch (args.command) {
    case 'backup':
      await commandBackup(args, effectiveTarget, sourcePath, backupPath);
      break;
    case 'build':
      await commandBuild(args, effectiveTarget, sourcePath, outputPath, buildContext);
      break;
    case 'apply':
    case 'install':
      await commandApply(args, effectiveTarget, sourcePath, outputPath, backupPath, buildContext);
      break;
    case 'restore':
    case 'uninstall':
      await commandRestore(args, effectiveTarget, sourcePath, backupPath);
      break;
    case 'auto':
      await commandApply(args, effectiveTarget, sourcePath, outputPath, backupPath, buildContext);
      if (!args.noStart) commandStart(args, effectiveTarget);
      break;
    case 'start':
      commandStart(args, effectiveTarget);
      break;
    case 'status':
      await commandStatus(args, effectiveTarget);
      break;
    case 'paths':
    case 'path':
      await commandPaths(args, effectiveTarget);
      break;
    case 'plugins':
    case 'list-plugins':
      await commandPlugins(args, effectiveTarget);
      break;
    case 'enable':
      await commandSetPluginEnabled(args, effectiveTarget, true);
      break;
    case 'disable':
      await commandSetPluginEnabled(args, effectiveTarget, false);
      break;
    case 'config':
      await commandConfig(args, effectiveTarget);
      break;
    case 'install-plugin':
      await commandInstallPlugin(args, effectiveTarget);
      break;
    case 'doctor':
      await commandDoctor(args, effectiveTarget);
      break;
    case 'list':
      printJson({
        plugins: defaultPluginIds,
        availablePlugins: await listAvailablePlugins(effectiveTarget),
        paths: pathsFor(effectiveTarget),
        targets,
      });
      break;
    default:
      throw new Error(`Unknown command: ${args.command}. Use --help.`);
  }
}

main().catch((error) => {
  console.error(`UnifyHub error: ${error.message || error}`);
  process.exit(1);
});
