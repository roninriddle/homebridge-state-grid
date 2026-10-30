import {readFileSync, writeFileSync} from 'node:fs';
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const lock = readFileSync(new URL('package-lock.json', root), 'utf8');
if (JSON.parse(lock).version !== pkg.version) throw new Error('Package/lock version mismatch');
// npm 不打包 package-lock.json；shrinkwrap 使用相同锁格式且可随正式包分发。
writeFileSync(new URL('npm-shrinkwrap.json', root), lock);
