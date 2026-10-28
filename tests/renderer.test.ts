/**
 * 渲染器自测：这里断言的是"输出确实是一张能用的 JPEG"，
 * 而不是像素级外观（外观靠 preview/ 里的样张人工确认）。
 */

import { describe, it, expect } from 'vitest';

import { renderCompactCard, renderDetailCard, type CardData } from '../src/renderer/card-svg.js';
import { fallbackCardSvg, renderJpeg, renderPng } from '../src/renderer/image-renderer.js';

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
    { date: '2026-10-25', usage: 16.8 },
    { date: '2026-10-26', usage: 14.1 },
    { date: '2026-10-27', usage: 15.4 },
  ],
  updatedAt: Date.UTC(2026, 9, 28, 5, 0),
};

describe('卡片 SVG', () => {
  it('含标题与主数值，且没有未转义的尖括号', () => {
    const svg = renderCompactCard(base);
    expect(svg).toContain('家庭用电');
    expect(svg).toContain('26.91');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('标题里的特殊字符被转义', () => {
    const svg = renderCompactCard({ ...base, title: '<script>&"' });
    expect(svg).toContain('&lt;script&gt;&amp;&quot;');
    expect(svg).not.toContain('<script>');
  });

  it('数据缺失时显示破折号而不是 0', () => {
    const svg = renderCompactCard({
      ...base,
      primaryValue: undefined,
      currentMonthUsage: undefined,
      latestDailyUsage: undefined,
      monthEstimateCharge: undefined,
    });
    expect(svg).toContain('暂无数据');
    expect(svg).not.toContain('0.00');
  });

  it('数据过期时显示未更新提示', () => {
    const svg = renderCompactCard({ ...base, staleNote: '数据未更新 · 最近成功 10月27日 12:00' });
    expect(svg).toContain('数据未更新');
  });

  it('详情版包含趋势标题与日期标签', () => {
    const svg = renderDetailCard(base);
    expect(svg).toContain('最近 7 日用电');
    expect(svg).toContain('10/27');
    expect(svg).toContain('本年累计电费');
  });
});

describe('JPEG 输出', () => {
  it('紧凑版是合法 JPEG 且宽度可指定', async () => {
    const jpeg = await renderJpeg(renderCompactCard(base), { width: 640 });
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(jpeg.subarray(-2).toString('hex')).toBe('ffd9');
    expect(jpeg.length).toBeGreaterThan(5000);
  });

  it('容器尺寸随宽度参数变化', async () => {
    const svg = renderDetailCard(base);
    const small = await renderJpeg(svg, { width: 480 });
    const large = await renderJpeg(svg, { width: 960 });
    expect(large.length).toBeGreaterThan(small.length);
  });

  it('兜底图也能生成有效 JPEG', async () => {
    const jpeg = await renderJpeg(fallbackCardSvg(320, 180, '数据获取失败'), { width: 320 });
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
  });
});

describe('PNG 中间产物', () => {
  it('PNG 宽度随参数变化，且带有效文件头', () => {
    const png = renderPng(renderCompactCard(base), { width: 480 });
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // IHDR 里的宽度是大端 32 位，位于第 16-19 字节。
    expect(png.readUInt32BE(16)).toBe(480);
  });
});
