/**
 * 生成卡片预览图，用来在没有国家电网账号的情况下调整版式。
 *
 * 运行：npm run build && node dist/tools/demo-render.js
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderCard, renderCompactCard, renderDetailCard, type CardData } from '../renderer/card-svg.js';
import { fallbackCardSvg, renderJpeg } from '../renderer/image-renderer.js';

const now = Date.now();

const base: CardData = {
  title: '家庭用电',
  primaryValue: 26.91,
  primaryLabel: '账户余额',
  latestDailyUsage: 15.4,
  latestDailyDate: '2026-10-27',
  currentMonthUsage: 391.16,
  monthEstimateCharge: 190.06,
  latestMonthUsage: 600,
  latestMonthCharge: 328.27,
  currentYearUsage: 6297.16,
  currentYearCharge: 3313.51,
  dailySeries: [
    { date: '2026-10-21', usage: 12.4 },
    { date: '2026-10-22', usage: 18.9 },
    { date: '2026-10-23', usage: 9.6 },
    { date: '2026-10-24', usage: 21.3 },
    { date: '2026-10-25', usage: 16.8 },
    { date: '2026-10-26', usage: 14.1 },
    { date: '2026-10-27', usage: 15.4 },
  ],
  updatedAt: now,
};

const stale: CardData = {
  ...base,
  updatedAt: now - 36 * 3600 * 1000,
  staleNote: '数据未更新 · 最近成功 10月27日 12:00',
};

async function main(): Promise<void> {
  const out = join(process.cwd(), 'preview');
  mkdirSync(out, { recursive: true });

  const outputs: Array<[string, Promise<Buffer>]> = [
    ['compact-light.jpg', renderJpeg(renderCompactCard({ ...base, theme: 'light' }), { width: 1280 })],
    ['compact-dark.jpg', renderJpeg(renderCompactCard({ ...base, theme: 'dark' }), { width: 1280 })],
    ['compact-stale.jpg', renderJpeg(renderCompactCard({ ...stale, theme: 'light' }), { width: 1280 })],
    ['detail-light.jpg', renderJpeg(renderDetailCard({ ...base, theme: 'light' }), { width: 1920, quality: 90 })],
    ['detail-dark.jpg', renderJpeg(renderDetailCard({ ...base, theme: 'dark' }), { width: 1920, quality: 90 })],
    ['custom-fields.jpg', renderJpeg(renderCard({ ...base, theme: 'light', fields: ['balance', 'currentMonthUsage', 'currentYearCharge'] }), { width: 1280 })],
    ['fallback.jpg', renderJpeg(fallbackCardSvg(1280, 720, '数据获取失败 · 最近成功 10月27日 12:00'), { width: 1280 })],
    ['compact-thumb.jpg', renderJpeg(renderCompactCard({ ...base, theme: 'light' }), { width: 360 })],
  ];

  for (const [name, pending] of outputs) {
    const buffer = await pending;
    writeFileSync(join(out, name), buffer);
    console.log(`${name}  ${(buffer.length / 1024).toFixed(1)} KB`);
  }
}

void main();
