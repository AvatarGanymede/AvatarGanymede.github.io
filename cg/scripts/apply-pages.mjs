/**
 * 把 Vite dist 同步到 GitHub Pages 可直接访问的路径：
 *   https://avatarganymede.github.io/cg/  →  cg/index.html + cg/assets/
 */
import { cpSync, existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const assets = join(root, 'assets');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('[apply-pages] dist/index.html 不存在，请先 vite build');
  process.exit(1);
}

rmSync(assets, { recursive: true, force: true });
cpSync(join(dist, 'assets'), assets, { recursive: true });
cpSync(join(dist, 'index.html'), join(root, 'index.html'));

// 不发布 source map
for (const name of readdirSync(assets)) {
  if (name.endsWith('.map')) unlinkSync(join(assets, name));
}

console.log('[apply-pages] 已同步 dist → index.html + assets/（供 /cg/ 发布）');
