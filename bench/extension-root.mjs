import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Benchmarks accept a repository checkout or an unpacked extension. Older
// checkouts stored the manifest at the repository root and JS under src/.
export function resolveExtension(directory = '.') {
  const requested = resolve(directory);
  const root = [requested, resolve(requested, 'src')]
    .find((candidate) => existsSync(resolve(candidate, 'manifest.json')));
  if (!root) throw new Error(`No extension manifest found in ${requested} or its src/ directory`);
  const moduleBase = existsSync(resolve(root, 'src/worker/index.js')) ? '/src/' : '/';
  return { root, moduleBase };
}
