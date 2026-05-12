import { open } from 'node:fs/promises';

const asarPath = process.env.UNITY_HUB_ASAR || 'C:/Program Files/Unity Hub/resources/app.asar';
const keyPaths = [
  'package.json',
  'build/main/index.js',
  'build/main/app-l6FSBuqi.js',
  'build/preload/mainWindowPreload.cjs',
  'build/preload/bugReporterPreload.cjs',
  'build/renderer/index.html',
  'build/renderer/bug-reporter.html',
];

async function openAsar(filePath) {
  const file = await open(filePath, 'r');
  const sizeBuffer = Buffer.alloc(8);
  await file.read(sizeBuffer, 0, 8, 0);
  const headerSize = sizeBuffer.readUInt32LE(4);
  const headerBuffer = Buffer.alloc(headerSize);
  await file.read(headerBuffer, 0, headerSize, 8);
  const jsonSize = headerBuffer.readUInt32LE(4);
  const headerJson = headerBuffer.subarray(8, 8 + jsonSize).toString('utf8').replace(/\0+$/g, '');
  return { file, header: JSON.parse(headerJson), contentOffset: 8 + headerSize };
}

function getNode(header, path) {
  let node = header;
  for (const part of path.split('/').filter(Boolean)) node = node.files?.[part];
  return node;
}

function walk(node, prefix = '', out = []) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    out.push({ path: fullPath, size: child.size || 0, unpacked: Boolean(child.unpacked), directory: Boolean(child.files) });
    if (child.files) walk(child, fullPath, out);
  }
  return out;
}

async function readFileFromAsar(asar, path) {
  const node = getNode(asar.header, path);
  if (!node || node.files || node.unpacked) return null;
  const buffer = Buffer.alloc(node.size);
  await asar.file.read(buffer, 0, node.size, asar.contentOffset + Number(node.offset));
  return buffer.toString('utf8');
}

const asar = await openAsar(asarPath);
try {
  const files = walk(asar.header);
  const packageJson = JSON.parse(await readFileFromAsar(asar, 'package.json'));
  const mainApp = await readFileFromAsar(asar, 'build/main/app-l6FSBuqi.js');
  const mainWindowMatch = mainApp.match(/class MainWindow[\s\S]{0,2600}?webPreferences:\s*\{([\s\S]{0,600}?)\}/);
  const cspMatch = mainApp.match(/Content-Security-Policy"\]\s*=\s*\[\[([\s\S]{0,900}?)\]\]/);

  console.log(JSON.stringify({
    asarPath,
    fileCount: files.length,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      main: packageJson.main,
      type: packageJson.type,
      electronOverride: packageJson.overrides?.electron,
      react: packageJson.dependencies?.react,
    },
    keyFiles: keyPaths.map((path) => {
      const node = getNode(asar.header, path);
      return { path, found: Boolean(node), size: node?.size || 0, unpacked: Boolean(node?.unpacked) };
    }),
    mainWindowWebPreferences: mainWindowMatch?.[1]?.trim() || null,
    packagedCspSnippet: cspMatch?.[1]?.replace(/\s+/g, ' ').trim() || null,
  }, null, 2));
} finally {
  await asar.file.close();
}
