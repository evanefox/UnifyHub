import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSlug } from './paths.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function normalizePath(value) {
  return value ? resolve(value) : '';
}

function defaultBackupPath(normalizedRoot, kind) {
  if (kind === 'development') return join(root, 'backups', 'dummy', 'app.asar.original');

  const legacyRealBackup = join(root, 'backups', 'real', 'app.asar.original');
  const isDefaultWindowsHub = normalizePath(normalizedRoot).toLowerCase() === normalizePath('C:/Program Files/Unity Hub').toLowerCase();
  if (isDefaultWindowsHub && existsSync(legacyRealBackup)) return legacyRealBackup;

  return join(root, 'backups', installSlug(normalizedRoot), 'app.asar.original');
}

function makeTarget(id, name, rootPath, kind = 'installed') {
  const normalizedRoot = normalizePath(rootPath);
  return {
    id,
    name,
    kind,
    rootPath: normalizedRoot,
    exePath: join(normalizedRoot, 'Unity Hub.exe'),
    asarPath: join(normalizedRoot, 'resources', 'app.asar'),
    backupPath: defaultBackupPath(normalizedRoot, kind),
  };
}

function isUnityHubRoot(rootPath) {
  return Boolean(rootPath)
    && existsSync(join(rootPath, 'Unity Hub.exe'))
    && existsSync(join(rootPath, 'resources', 'app.asar'));
}

function addTarget(targets, target) {
  if (!isUnityHubRoot(target.rootPath)) return;
  const key = normalizePath(target.rootPath).toLowerCase();
  if ([...targets.values()].some((item) => normalizePath(item.rootPath).toLowerCase() === key)) return;
  targets.set(target.id, target);
}

function registryInstallRoots() {
  if (process.platform !== 'win32') return [];
  const script = `
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$roots | ForEach-Object {
  Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Unity Hub*' -and $_.InstallLocation } |
    ForEach-Object { $_.InstallLocation }
}
`;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function discoverTargets({ includeDev = process.env.UNIFYHUB_DEV === '1' } = {}) {
  const targets = new Map();
  const envRoot = process.env.UNITY_HUB_ROOT || process.env.UNITY_HUB_PATH;
  if (envRoot) addTarget(targets, makeTarget('auto', 'Unity Hub', envRoot));

  for (const rootPath of [
    'C:/Program Files/Unity Hub',
    'C:/Program Files (x86)/Unity Hub',
    ...registryInstallRoots(),
  ]) {
    addTarget(targets, makeTarget(targets.has('auto') ? `installed-${targets.size}` : 'auto', 'Unity Hub', rootPath));
  }

  if (includeDev) {
    const devRoot = join(root, 'UnityHubDummyTarget', 'Unity Hub');
    addTarget(targets, makeTarget('dev', 'Development Dummy Unity Hub', devRoot, 'development'));
  }

  return Object.fromEntries(targets);
}

export function resolveTarget(targetId = process.env.UNIFYHUB_TARGET || 'auto') {
  const requested = targetId === 'real' ? 'auto' : targetId === 'dummy' ? 'dev' : targetId;
  const targets = discoverTargets({ includeDev: requested === 'dev' || process.env.UNIFYHUB_DEV === '1' });
  const target = targets[requested] || (requested === 'auto' ? Object.values(targets)[0] : null);
  if (!target) {
    const known = Object.keys(targets).length ? Object.keys(targets).join(', ') : 'none';
    throw new Error(`Unity Hub target not found: ${targetId}. Known targets: ${known}. Set UNITY_HUB_ROOT to a Unity Hub install folder if detection missed it.`);
  }
  return target;
}

export const targets = discoverTargets();
