// 逐一语法检查项目内的 JS 文件。此前 package.json 手工罗列文件，
// 新增模块不会被检查到（lib/runtime.mjs 等 7 个文件曾长期漏检）。
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 不 import 项目模块：被检查文件本身可能有语法错误，脚本必须先能独立运行。
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const directories = ['desktop', 'lib', 'public', 'tools', 'tests'];
const files = ['server.mjs'];
for (const directory of directories) {
  for (const name of await readdir(join(projectRoot, directory))) {
    if (/\.(?:[cm]?js)$/.test(name)) files.push(`${directory}/${name}`);
  }
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status === 0) continue;
  failed++;
  console.error(`[语法错误] ${file}\n${(result.stderr || '').trim()}\n`);
}

console.log(`语法检查：${files.length} 个文件，${failed ? `${failed} 个未通过` : '全部通过'}`);
process.exit(failed ? 1 : 0);
