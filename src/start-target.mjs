import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTarget } from './targets.mjs';

function parseArgs(argv) {
  const args = { targetId: process.env.UNIFYHUB_TARGET || 'auto', extraArgs: [] };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      args.targetId = argv[index + 1];
      index += 1;
    } else {
      args.extraArgs.push(arg);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const target = resolveTarget(args.targetId);
const projectRoot = resolve(import.meta.dirname, '..');

if (!existsSync(target.exePath)) {
  throw new Error(`Unity Hub executable not found: ${target.exePath}`);
}

console.log(`[UnifyHub] starting ${target.name}`);
console.log(`[UnifyHub] exe ${target.exePath}`);

const child = spawn(target.exePath, args.extraArgs, {
  cwd: target.rootPath,
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    UNIFYHUB_HOME: projectRoot,
    UNIFYHUB_TARGET: target.id,
    UNIFYHUB_TARGET_ROOT: target.rootPath,
  },
});
child.unref();
console.log(`[UnifyHub] started pid ${child.pid}`);
