import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { inject } from './injector.mjs';

const unityHubPath = process.env.UNITY_HUB_EXE || 'C:/Program Files/Unity Hub/Unity Hub.exe';
const port = Number(process.env.UNIFYHUB_DEBUG_PORT || 9333);

if (!existsSync(unityHubPath)) {
  throw new Error(`Unity Hub executable not found: ${unityHubPath}`);
}

const args = [
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=http://127.0.0.1',
];

console.log(`[UnifyHub] launching ${unityHubPath}`);
console.log(`[UnifyHub] debug endpoint http://127.0.0.1:${port}`);

const child = spawn(unityHubPath, args, {
  detached: true,
  stdio: 'ignore',
});
child.unref();

for (let attempt = 1; attempt <= 40; attempt += 1) {
  try {
    await inject({ port });
    console.log('[UnifyHub] injection complete');
    process.exit(0);
  } catch (error) {
    if (attempt === 40) throw error;
    await delay(500);
  }
}
