import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const forbidden = new Set(['@poker/engine', '@poker/strategies', '@poker/solver', '@poker/simulation', '@poker/research', '@poker/server']);
const manifests = new Map();
for (const area of ['packages', 'apps']) {
  for (const entry of await readdir(path.join(root, area), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(await readFile(path.join(root, area, entry.name, 'package.json'), 'utf8'));
    manifests.set(manifest.name, manifest);
  }
}
function reachable(name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);
  const manifest = manifests.get(name);
  for (const dependency of Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies })) {
    if (manifests.has(dependency)) reachable(dependency, seen);
  }
  return seen;
}
for (const name of reachable('@poker/playground')) if (forbidden.has(name)) throw new Error('Browser dependency reaches authoritative package: ' + name);
for (const name of reachable('@poker/engine')) if (['@poker/strategies', '@poker/research'].includes(name)) throw new Error('Engine depends on ' + name);
for (const name of ['@poker/strategies', '@poker/solver', '@poker/simulation']) if (reachable(name).has('@poker/research')) throw new Error(name + ' depends on Research');
for (const name of reachable('@poker/contracts')) if (forbidden.has(name)) throw new Error('Safe contracts reach ' + name);
console.log('Workspace dependency boundaries pass; Vite also rejects authoritative runtime imports.');
