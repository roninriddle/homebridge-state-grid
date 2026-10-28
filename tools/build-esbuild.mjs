/**
 * 用 esbuild 把 src 逐文件转译到 dist。
 *
 * 为什么要有这条路径：`tsc` 在这台机器上偶尔会因文件系统受限被外部杀掉，
 * 而 esbuild 只做语法层转译、不做类型检查，几十毫秒就跑完。
 *
 * 注意分工：
 *  - 发版前必须跑 `npm run build`（tsc），它会真正检查类型；
 *  - 本地快速迭代、只为拿到能跑的 dist，用 `npm run build:fast`。
 *
 * 两者产出的模块形态一致（CommonJS，import 路径原样保留），可以互相覆盖。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { transformSync } from 'esbuild';

const root = process.cwd();
const srcDir = join(root, 'src');
const outDir = join(root, 'dist');

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (full.endsWith('.ts')) files.push(full);
  }
  return files;
}

const files = walk(srcDir);
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const result = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node22',
    sourcemap: true,
    sourcefile: relative(root, file),
  });
  const target = join(outDir, relative(srcDir, file)).replace(/\.ts$/, '.js');
  // 目标目录已存在的就不要调 mkdir：某些受限环境里 mkdir 一律被拒。
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target, result.code);
  if (result.map) writeFileSync(`${target}.map`, result.map);
}

console.log(`esbuild 转译完成：${files.length} 个文件 → dist/`);
