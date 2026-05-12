import { copyFile, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function align(value, size = 4) {
  return Math.ceil(value / size) * size;
}

export async function readAsar(filePath) {
  const handle = await open(filePath, 'r');
  const first = Buffer.alloc(8);
  await handle.read(first, 0, 8, 0);
  const headerSize = first.readUInt32LE(4);
  const headerBuffer = Buffer.alloc(headerSize);
  await handle.read(headerBuffer, 0, headerSize, 8);
  const jsonSize = headerBuffer.readUInt32LE(4);
  const headerJson = headerBuffer.subarray(8, 8 + jsonSize).toString('utf8').replace(/\0+$/g, '');
  return { handle, header: JSON.parse(headerJson), contentOffset: 8 + headerSize };
}

export function getNode(header, filePath) {
  let node = header;
  for (const part of filePath.split('/').filter(Boolean)) node = node.files?.[part];
  return node;
}

export function forEachFile(node, visitor, filePath = '') {
  for (const [name, child] of Object.entries(node.files || {})) {
    const childPath = filePath ? `${filePath}/${name}` : name;
    if (child.files) forEachFile(child, visitor, childPath);
    else visitor(child, childPath);
  }
}

export async function readArchivedFile(asar, node) {
  const buffer = Buffer.alloc(node.size || 0);
  await asar.handle.read(buffer, 0, buffer.length, asar.contentOffset + Number(node.offset || 0));
  return buffer;
}

export function withUpdatedIntegrity(node, buffer) {
  if (!node.integrity) return;
  const algorithm = node.integrity.algorithm || 'SHA256';
  const blockSize = node.integrity.blockSize || 4_194_304;
  const hashName = algorithm.toLowerCase().replace('-', '');
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    blocks.push(createHash(hashName).update(buffer.subarray(offset, offset + blockSize)).digest('hex'));
  }
  node.integrity = {
    algorithm,
    hash: createHash(hashName).update(buffer).digest('hex'),
    blockSize,
    blocks,
  };
}

function makeHeaderBuffer(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const jsonPickleSize = align(4 + json.length);
  const headerPickleSize = 4 + jsonPickleSize;
  const headerBuffer = Buffer.alloc(headerPickleSize);
  headerBuffer.writeUInt32LE(jsonPickleSize, 0);
  headerBuffer.writeUInt32LE(json.length, 4);
  json.copy(headerBuffer, 8);

  const sizeBuffer = Buffer.alloc(8);
  sizeBuffer.writeUInt32LE(4, 0);
  sizeBuffer.writeUInt32LE(headerPickleSize, 4);
  return Buffer.concat([sizeBuffer, headerBuffer]);
}

function applyBuildTokens(text, context) {
  const tokens = {
    __UNIFYHUB_PROJECT_ROOT_JSON__: JSON.stringify(context.projectRoot || ''),
    __UNIFYHUB_TARGET_ID_JSON__: JSON.stringify(context.targetId || ''),
    __UNIFYHUB_TARGET_ROOT_JSON__: JSON.stringify(context.targetRoot || ''),
  };
  let next = text;
  for (const [token, value] of Object.entries(tokens)) next = next.replaceAll(token, value);
  return next;
}

async function assertInsideDirectory(baseDir, childPath, label) {
  const base = await realpath(baseDir);
  const child = await realpath(childPath);
  const rel = relative(base, child);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return;
  throw new Error(`${label} must stay inside ${base}: ${child}`);
}

async function replacementText(replacement, plugin, context) {
  if (typeof replacement.replace === 'string') return applyBuildTokens(replacement.replace, context);
  if (typeof replacement.replaceFromFile === 'string') {
    if (!plugin.pluginDir) throw new Error(`Plugin ${plugin.id} is missing pluginDir for replaceFromFile.`);
    const replacementPath = resolve(plugin.pluginDir, replacement.replaceFromFile);
    await assertInsideDirectory(plugin.pluginDir, replacementPath, `Plugin ${plugin.id} replaceFromFile`);
    return applyBuildTokens(await readFile(replacementPath, 'utf8'), context);
  }
  throw new Error(`Plugin ${plugin.id} replacement for ${replacement.file} needs replace or replaceFromFile.`);
}

async function applyTextReplacement(text, replacement, plugin, context) {
  if (replacement.alreadyPatchedFind && text.includes(replacement.alreadyPatchedFind)) {
    return { text, status: 'already-applied' };
  }

  const find = replacement.find;
  const replace = await replacementText(replacement, plugin, context);
  const count = text.split(find).length - 1;

  if (count === 0) {
    if (replacement.required === false) return { text, status: 'not-found-optional' };
    throw new Error(`Plugin ${plugin.id} could not find text in ${replacement.file}: ${find}`);
  }

  if (replacement.once !== false && count > 1) {
    throw new Error(`Plugin ${plugin.id} found ${count} matches in ${replacement.file}; refusing ambiguous patch.`);
  }

  return {
    text: replacement.once === false ? text.replaceAll(find, replace) : text.replace(find, replace),
    status: 'applied',
  };
}

async function applyPluginToText(text, plugin, filePath, context) {
  const results = [];
  let nextText = text;
  for (const replacement of plugin.replacements.filter((item) => item.file === filePath)) {
    const result = await applyTextReplacement(nextText, replacement, plugin, context);
    nextText = result.text;
    results.push({ plugin: plugin.id, file: filePath, status: result.status });
  }
  return { text: nextText, results };
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*');
  return new RegExp(`^${escaped}$`);
}

async function resolveReplacementFiles(asar, payloads, plugins) {
  const filePaths = [...payloads.keys()];
  for (const plugin of plugins) {
    const resolved = [];
    for (const replacement of plugin.replacements) {
      const pattern = replacement.filePattern || replacement.file;
      if (!pattern) throw new Error(`Plugin ${plugin.id} replacement needs file or filePattern.`);
      if (!replacement.filePattern && !pattern.includes('*')) {
        resolved.push(replacement);
        continue;
      }

      const matcher = globToRegExp(pattern);
      const candidatePaths = filePaths.filter((filePath) => matcher.test(filePath));
      const matches = [];
      for (const filePath of candidatePaths) {
        const node = getNode(asar.header, filePath);
        const text = (await readArchivedFile(asar, node)).toString('utf8');
        const already = replacement.alreadyPatchedFind && text.includes(replacement.alreadyPatchedFind);
        const fresh = replacement.find && text.includes(replacement.find);
        if (already || fresh) matches.push(filePath);
      }

      if (matches.length === 0) {
        if (replacement.required === false) continue;
        throw new Error(`Plugin ${plugin.id} could not resolve ${pattern}; no candidate contained the patch anchor.`);
      }
      if (matches.length > 1 && replacement.once !== false) {
        throw new Error(`Plugin ${plugin.id} resolved ${pattern} to multiple files: ${matches.join(', ')}`);
      }

      for (const filePath of matches) resolved.push({ ...replacement, file: filePath, resolvedFrom: pattern });
    }
    plugin.replacements = resolved;
  }
}

function normalizePlugin(plugin) {
  if (!plugin.id || !plugin.name) throw new Error('Plugin manifest requires id and name.');
  if (!Array.isArray(plugin.replacements)) throw new Error(`Plugin ${plugin.id} requires replacements array.`);
  return plugin;
}

export async function createPatchedAsar({ sourcePath, outputPath, plugins, context = {} }) {
  const normalizedPlugins = plugins.map(normalizePlugin);
  const asar = await readAsar(sourcePath);
  const payloads = new Map();
  const results = [];

  try {
    forEachFile(asar.header, (node, filePath) => {
      if (!node.unpacked && typeof node.size === 'number') payloads.set(filePath, null);
    });

    await resolveReplacementFiles(asar, payloads, normalizedPlugins);

    for (const filePath of payloads.keys()) {
      const node = getNode(asar.header, filePath);
      let buffer = await readArchivedFile(asar, node);
      const interestedPlugins = normalizedPlugins.filter((plugin) => plugin.replacements.some((item) => item.file === filePath));

      if (interestedPlugins.length) {
        let text = buffer.toString('utf8');
        for (const plugin of interestedPlugins) {
          const pluginResult = await applyPluginToText(text, plugin, filePath, context);
          text = pluginResult.text;
          results.push(...pluginResult.results);
        }
        buffer = Buffer.from(text, 'utf8');
      }

      payloads.set(filePath, buffer);
    }
  } finally {
    await asar.handle.close();
  }

  let offset = 0;
  for (const [filePath, buffer] of payloads) {
    const node = getNode(asar.header, filePath);
    node.offset = String(offset);
    node.size = buffer.length;
    withUpdatedIntegrity(node, buffer);
    offset += buffer.length;
  }

  const headerBuffer = makeHeaderBuffer(asar.header);
  const chunks = [headerBuffer];
  for (const buffer of payloads.values()) chunks.push(buffer);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.concat(chunks));

  return { outputPath, plugins: normalizedPlugins.map((plugin) => plugin.id), results };
}

export async function readAsarPackageInfo(filePath) {
  const asar = await readAsar(filePath);
  try {
    const node = getNode(asar.header, 'package.json');
    if (!node) return null;
    const data = JSON.parse((await readArchivedFile(asar, node)).toString('utf8').replace(/^\uFEFF/, ''));
    return {
      name: data.name || '',
      version: data.version || '',
      electronVersion: data.devDependencies?.electron || data.dependencies?.electron || '',
    };
  } finally {
    await asar.handle.close();
  }
}

export async function asarHasUnifyHubPatch(filePath) {
  const markers = ['__unifyHubBridgeInstalled', 'unifyhub-plugin-manager-script', 'installUnifyHubDevTools', 'UNIFYHUB_PLUGIN_PATCH:'];
  const asar = await readAsar(filePath);
  try {
    const scanNodes = [];
    forEachFile(asar.header, (node, filePathInAsar) => {
      if (node.unpacked || typeof node.size !== 'number') return;
      if (/\.(js|cjs|mjs|html|json|css)$/i.test(filePathInAsar)) scanNodes.push(node);
    });
    for (const node of scanNodes) {
      const text = (await readArchivedFile(asar, node)).toString('utf8');
      if (markers.some((marker) => text.includes(marker))) return true;
    }
    return false;
  } finally {
    await asar.handle.close();
  }
}

function backupArchivePath(backupPath, info) {
  const version = (info?.version || 'unknown').replace(/[^a-z0-9._-]+/gi, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${backupPath}.${version}.${stamp}.stale`;
}

export async function backupIfNeeded(sourcePath, backupPath) {
  try {
    await stat(backupPath);
    return false;
  } catch {
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(sourcePath, backupPath);
    return true;
  }
}

export async function ensureFreshBackup(sourcePath, backupPath) {
  try {
    await stat(backupPath);
  } catch {
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(sourcePath, backupPath);
    return { backupCreated: true, backupRefreshed: false, backupArchivedTo: null, reason: 'created' };
  }

  const [sourceInfo, backupInfo, sourcePatched] = await Promise.all([
    readAsarPackageInfo(sourcePath).catch(() => null),
    readAsarPackageInfo(backupPath).catch(() => null),
    asarHasUnifyHubPatch(sourcePath).catch(() => false),
  ]);

  const sourceVersion = sourceInfo?.version || '';
  const backupVersion = backupInfo?.version || '';
  const versionChanged = sourceVersion && backupVersion && sourceVersion !== backupVersion;

  if (versionChanged) {
    if (sourcePatched) {
      throw new Error(`Backup is for Unity Hub ${backupVersion}, but installed Unity Hub is ${sourceVersion} and already looks patched. Restore the clean backup or update Unity Hub to a clean install, then apply UnifyHub again.`);
    }

    const archivePath = backupArchivePath(backupPath, backupInfo);
    await rename(backupPath, archivePath);
    await copyFile(sourcePath, backupPath);
    return { backupCreated: false, backupRefreshed: true, backupArchivedTo: archivePath, reason: `updated ${backupVersion} -> ${sourceVersion}` };
  }

  return { backupCreated: false, backupRefreshed: false, backupArchivedTo: null, reason: 'current' };
}

export async function installAsar(sourcePath, patchedPath) {
  const tempPath = `${sourcePath}.unifyhub.tmp`;
  await copyFile(patchedPath, tempPath);
  try {
    await unlink(sourcePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await rename(tempPath, sourcePath);
}

export async function restoreAsar(sourcePath, backupPath) {
  await copyFile(backupPath, sourcePath);
}
