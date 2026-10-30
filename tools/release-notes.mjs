import {readFileSync} from 'node:fs';
const {version} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const notes = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const section = notes.split(/^## /m).find(s => s.startsWith(version + ' '));
if (!section) throw new Error('Missing changelog for ' + version);
console.log('## ' + section.trim() + '\n\n安装包包含编译产物与依赖锁文件；SHA256SUMS 可用于下载校验。');
