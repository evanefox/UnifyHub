import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateDir = join(root, 'templates', 'plugin');
const pluginsDir = join(root, 'plugins');

function toPluginId(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toPluginName(id) {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function parseArgs(argv) {
  const args = { id: '', name: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--name') {
      args.name = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (!args.id) {
      args.id = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Create an UnifyHub plugin from the template

Usage:
  node src\\create-plugin.mjs my-plugin
  node src\\create-plugin.mjs my-plugin --name "My Plugin"
`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function replaceTokensInTextFiles(dir, replacements) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await replaceTokensInTextFiles(path, replacements);
      continue;
    }
    if (!/\.(json|md|txt|html|js|cjs|mjs|css)$/i.test(entry.name)) continue;
    let text = await readFile(path, 'utf8');
    for (const [token, value] of Object.entries(replacements)) {
      text = text.replaceAll(token, value);
    }
    await writeFile(path, text);
  }
}

const args = parseArgs(process.argv);
if (args.help) {
  printHelp();
  process.exit(0);
}

const id = toPluginId(args.id || '');
if (!id) throw new Error('Missing plugin id. Example: node src\\create-plugin.mjs my-plugin');

const name = args.name?.trim() || toPluginName(id);
const targetDir = join(pluginsDir, basename(id));

if (await exists(targetDir)) throw new Error(`Plugin already exists: ${targetDir}`);

await mkdir(pluginsDir, { recursive: true });
await cp(templateDir, targetDir, { recursive: true });
await replaceTokensInTextFiles(targetDir, {
  __PLUGIN_ID__: id,
  __PLUGIN_NAME__: name,
});

console.log(JSON.stringify({ created: targetDir, id, name }, null, 2));
