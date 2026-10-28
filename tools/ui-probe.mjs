/**
 * 设置页自测：不联网、不需要 Homebridge，把「装配设备档案 → 挂路由 → 调接口」
 * 整条链路跑一遍。
 *
 * 断言的都是"不需要真账号也能判断对错"的事情：
 *  1. storage 目录结构正确建立，设备种子落盘且可复用；
 *  2. /status 在未配置凭据时不会崩，而是返回明确的提示；
 *  3. 缺凭据时 /accounts 返回结构化错误，而不是抛异常；
 *  4. 未知户号的 /preview 给出人话；
 *  5. 卡片渲染器能把快照渲染成 JPEG（这条会真的调用 resvg）。
 *
 * 用法：node tools/ui-probe.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { UiGateway } = require('../homebridge-ui/lib/gateway.js');
const { registerRoutes } = require('../homebridge-ui/lib/routes.js');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 用一个假的 server 收集路由，之后按路径调用。 */
function fakeServer() {
  const routes = new Map();
  return {
    onRequest(path, handler) {
      routes.set(path, handler);
    },
    async call(path, payload) {
      const handler = routes.get(path);
      if (!handler) throw new Error(`路由 ${path} 未注册`);
      return handler(payload);
    },
    paths: () => [...routes.keys()],
  };
}

async function main() {
  const storage = mkdtempSync(join(tmpdir(), 'sg-ui-probe-'));
  try {
    console.log('设置页自测');

    const gateway = new UiGateway(storage);
    const server = fakeServer();
    registerRoutes(server, gateway);

    console.log('\n[路由]');
    for (const path of ['/status', '/login', '/send-sms', '/verify', '/accounts', '/preview', '/reset']) {
      check(`已注册 ${path}`, server.paths().includes(path));
    }

    console.log('\n[状态]');
    const status = await server.call('/status');
    check('未登录时 ok=true', status.ok === true);
    check('hasPassword 为 false', status.hasPassword === false);
    check('hasSession 为 false', status.hasSession === false);
    check('storagePath 指回原目录', status.storagePath === storage, status.storagePath);

    console.log('\n[设备档案]');
    // 设备档案只有在登录（ensureClient）时才装配并落盘；这里显式走一遍装配，
    // 验证「种子生成 → 落盘 → 跨进程复用」这条链路，而不依赖真实账号。
    const { assembleProfile } = require('../dist/services/device-profile.js');
    const assembled = assembleProfile(gateway.store);
    const deviceFile = join(storage, 'state-grid', 'device.json');
    const device = JSON.parse(readFileSync(deviceFile, 'utf8'));
    check('device.json 已落盘', Boolean(device.profile));
    check('含设备种子 seedB64', typeof device.profile.seedB64 === 'string' && device.profile.seedB64.length > 20);
    check('token 已生成并缓存', Boolean(device.tokenCache && device.tokenCache.token && device.tokenCache.token.startsWith('v3:')));

    // 再建一个 gateway 读同一个目录，种子必须一致（跨进程一致性）。
    const second = new UiGateway(storage);
    const assembled2 = assembleProfile(second.store);
    const seed2 = JSON.parse(readFileSync(deviceFile, 'utf8')).profile.seedB64;
    check('重新装配后种子不变', seed2 === device.profile.seedB64);

    console.log('\n[缺凭据]');
    const accounts = await server.call('/accounts');
    check('返回结构化错误', accounts.ok === false);
    check('提示要求填写手机号', /手机号/.test(accounts.message || ''), accounts.message);

    const preview = await server.call('/preview', { consNo: '0000000000' });
    check('预览也返回结构化错误', preview.ok === false, JSON.stringify(preview));

    console.log('\n[渲染]');
    // 直接验渲染链路：快照 → SVG → JPEG，不依赖网络。
    const { renderCompactCard } = require('../dist/renderer/card-svg.js');
    const { renderJpeg } = require('../dist/renderer/image-renderer.js');
    const jpeg = await renderJpeg(
      renderCompactCard({
        title: '测试户号',
        primaryValue: 123.45,
        primaryLabel: '账户余额',
        latestDailyUsage: 6.28,
        latestDailyDate: '2026-10-27',
        currentMonthUsage: 187.4,
        monthEstimateCharge: 98.6,
        latestMonthUsage: 302.1,
        latestMonthCharge: 158.9,
        currentYearUsage: 2311.3,
        currentYearCharge: 1210.4,
        dailySeries: [3, 5, 4, 7, 6, 2, 8].map((usage, index) => ({
          date: `2026-10-2${index}`,
          usage,
        })),
        updatedAt: Date.now(),
        theme: 'light',
      }),
      { width: 640, quality: 80 },
    );
    check('输出是 JPEG', jpeg[0] === 0xff && jpeg[1] === 0xd8, `${jpeg[0]},${jpeg[1]}`);
    check('体积合理（>10KB）', jpeg.length > 10_000, `${jpeg.length} 字节`);

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
