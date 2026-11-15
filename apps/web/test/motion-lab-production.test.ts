import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

// The motion lab (ADR-0040) is development only: main.tsx loads it behind `import.meta.env.DEV`. A production build must
// carry none of it, neither its route nor its code nor its styles. The build runs in its own process with NODE_ENV set
// to production, as `pnpm build` does: the test runner's own NODE_ENV would leave DEV true.
describe('a production build', () => {
  it('has no motion lab in it', () => {
    const vite = join(dirname(createRequire(join(root, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
    const outDir = mkdtempSync(join(tmpdir(), 'poker-web-build-'));
    try {
      execFileSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, stdio: 'pipe' });
      const output = files(outDir).filter(f => /\.(js|css|html)$/.test(f));
      expect(output.length).toBeGreaterThan(0);
      for (const file of output) {
        const text = readFileSync(file, 'utf8');
        for (const marker of ['/motion-lab', 'MotionLabPage', 'lab-beat', 'lab-timeline']) expect({ file, marker, found: text.includes(marker) }).toEqual({ file, marker, found: false });
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
