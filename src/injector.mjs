import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const defaultPort = Number(process.env.UNIFYHUB_DEBUG_PORT || 9333);
const root = resolve(import.meta.dirname, '..');

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json();
}

function pickUnityHubTarget(targets) {
  return targets.find((target) => {
    const url = target.url || '';
    return target.type === 'page' && (
      url.endsWith('/build/renderer/index.html') ||
      url.includes('/build/renderer/index.html#') ||
      target.title === 'Unity Hub'
    );
  }) || targets.find((target) => target.type === 'page' && (target.url || '').startsWith('file://'));
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketDebuggerUrl);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', rejectOpen, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const result = new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
    });
    this.socket.send(payload);
    return result;
  }

  close() {
    this.socket.close();
  }
}

function jsString(value) {
  return JSON.stringify(value);
}

async function waitForTarget(port) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const targets = await getJson(`http://127.0.0.1:${port}/json`);
    const target = pickUnityHubTarget(targets);
    if (target?.webSocketDebuggerUrl) return target;
    await delay(500);
  }
  throw new Error('Unity Hub renderer target was not found on the debug endpoint.');
}

export async function inject({ port = defaultPort } = {}) {
  const target = await waitForTarget(port);
  console.log(`[UnifyHub] target: ${target.title || '(untitled)'} ${target.url}`);

  const css = await readFile(resolve(root, 'mods/example/style.css'), 'utf8');
  const mod = await readFile(resolve(root, 'mods/example/index.js'), 'utf8');

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Runtime.evaluate', {
      expression: `(() => {
        const id = 'unifyhub-example-style';
        let style = document.getElementById(id);
        if (!style) {
          style = document.createElement('style');
          style.id = id;
          document.head.appendChild(style);
        }
        style.textContent = ${jsString(css)};
      })();`,
      awaitPromise: true,
    });
    await client.send('Runtime.evaluate', {
      expression: `(() => {
        const run = new Function(${jsString(mod)});
        run();
      })();`,
      awaitPromise: true,
    });
  } finally {
    client.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  inject().catch((error) => {
    console.error(`[UnifyHub] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
