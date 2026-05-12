import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function installSlug(rootPath) {
  return resolve(rootPath)
    .replace(/^[\\/]+/, '')
    .replace(/[:\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function appDataRoot() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
}

export function unifyHubDataRoot() {
  return process.env.UNIFYHUB_DATA_HOME || join(appDataRoot(), 'UnifyHub');
}

export function targetDataDir(target) {
  return join(unifyHubDataRoot(), 'installs', installSlug(target.rootPath));
}

export function targetPluginsDir(target) {
  return join(targetDataDir(target), 'plugins');
}

export function targetStatePath(target) {
  return join(targetDataDir(target), 'state.json');
}
