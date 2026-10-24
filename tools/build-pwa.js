// Actualiza la lista de archivos y la versión del service worker (example/sw.js).
// Uso: node tools/build-pwa.js          → reescribe sw.js
//      node tools/build-pwa.js --check  → falla si sw.js no está al día (lo usan los tests)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const example = join(root, 'example');
const swPath = join(example, 'sw.js');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function precacheList() {
  const files = [
    ...walk(example).filter((p) => p !== swPath),
    ...walk(join(root, 'src')),
  ].sort();
  return files.map((p) => {
    const rel = relative(example, p).split(sep).join('/');
    return { url: rel.startsWith('..') ? rel : `./${rel}`, path: p };
  });
}

export function buildSw() {
  const list = precacheList();
  const hash = createHash('sha256');
  for (const f of list) hash.update(f.url).update(readFileSync(f.path));
  const version = hash.digest('hex').slice(0, 10);
  const urls = ['./', ...list.map((f) => f.url)];
  const block = `// <precache>\nconst VERSION = '${version}';\nconst PRECACHE = [\n${urls.map((u) => `  '${u}',`).join('\n')}\n];\n// </precache>`;
  const current = readFileSync(swPath, 'utf8');
  const next = current.replace(/\/\/ <precache>[\s\S]*?\/\/ <\/precache>/, block);
  return { current, next, version, count: urls.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { current, next, version, count } = buildSw();
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error('example/sw.js no está al día: ejecuta `npm run pwa`');
      process.exit(1);
    }
    console.log(`sw.js al día (versión ${version})`);
  } else {
    writeFileSync(swPath, next);
    console.log(`sw.js: versión ${version}, ${count} archivos`);
  }
}
