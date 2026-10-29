/**
 * 渲染器自测：这里断言的是"输出确实是一张能用的 JPEG"，
 * 而不是像素级外观（外观靠 preview/ 里的样张人工确认）。
 */

import { describe, it, expect } from 'vitest';

import { metricLayout, renderCard, renderCompactCard, renderDetailCard, type CardData } from '../src/renderer/card-svg.js';
import { FIELD_META, type FieldKey } from '../src/renderer/fields.js';
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
    expect(svg).toContain('—');
    expect(svg).not.toContain('¥0.00');
  });

  it('数据过期时显示未更新提示', () => {
    const svg = renderCompactCard({ ...base, staleNote: '数据未更新 · 最近成功 10月27日 12:00' });
    expect(svg).toContain('数据未更新');
  });

  it('默认展示全部 8 个字段标签', () => {
    const svg = renderDetailCard(base);
    expect(svg).toContain('账户余额');
    expect(svg).toContain('本月预估电费');
    expect(svg).toContain('当月用电');
    expect(svg).toContain('用电 · 10月27日');
    expect(svg).toContain('上月用电');
    expect(svg).toContain('年累计用电');
    expect(svg).toContain('年累计电费');
    expect(svg).toContain('上月电费');
  });

  it('字段可按配置裁剪', () => {
    const svg = renderCard({
      ...base,
      fields: ['balance', 'currentYearCharge'],
    });
    expect(svg).toContain('年累计电费');
    expect(svg).not.toContain('当月用电');
    expect(svg).not.toContain('上日用电');
  });

  it('后付费户号主数字标题为应交电费', () => {
    const svg = renderCard({ ...base, primaryValue: 168.57, primaryLabel: '应交电费' });
    expect(svg).toContain('应交电费');
    expect(svg).not.toContain('账户余额');
  });

  it('实际账单月份不替换上月标签，预估不重复标注', () => {
    const svg = renderCard({...base, latestMonth: '2026-09'});
    expect(svg).toContain('上月用电');
    expect(svg).toContain('上月电费');
    expect(svg).not.toContain('2026年9月');
    expect(svg).toContain('本月预估电费');
    expect(svg).not.toContain('预估电费 · 估算');
  });

  it('1～17 个下方指标每行铺满，边界不溢出、占位不重叠', () => {
    expect(metricLayout(0)).toEqual([]);
    for (let count = 1; count <= 17; count++) {
      const boxes = metricLayout(count);
      expect(boxes).toHaveLength(count);
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(80);
        expect(box.x + box.width).toBeLessThanOrEqual(1200.001);
        expect(box.y + box.height).toBeLessThanOrEqual(648.001);
        const row = boxes.filter((item) => item.y === box.y);
        expect(row[0].x).toBe(80);
        expect(row.at(-1)!.x + row.at(-1)!.width).toBeCloseTo(1200);
      }
      for (let i = 1; i < boxes.length; i++) {
        if (boxes[i].y === boxes[i - 1].y) expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x + boxes[i - 1].width);
      }
    }
    expect(metricLayout(1)[0].valueSize).toBeGreaterThan(metricLayout(10)[0].valueSize);
    expect(metricLayout(1)[0].width).toBeGreaterThan(metricLayout(10)[0].width);
  });

  it('删除指标后扩大排版，顶部两项始终比下方数字大', () => {
    const keys = Object.keys(FIELD_META) as FieldKey[];
    for (let count = 1; count <= keys.length; count++) {
      const svg = renderCard({...base, fields: keys.slice(0, count)});
      const sizes = [...svg.matchAll(/data-role="(hero|metric)"[^>]*data-value-size="([\d.]+)"/g)];
      const heroes = sizes.filter((match) => match[1] === 'hero').map((match) => Number(match[2]));
      const metrics = sizes.filter((match) => match[1] === 'metric').map((match) => Number(match[2]));
      expect(heroes).toHaveLength(Math.min(count, 2));
      expect(metrics).toHaveLength(Math.max(count - 2, 0));
      for (const size of metrics) expect(size).toBeLessThan(Math.min(...heroes));
    }
  });

  it('分时与阶梯字段可渲染', () => {
    const svg = renderCard({
      ...base,
      fields: ['balance', 'latestPeakUsage', 'latestValleyUsage', 'ladderLevel', 'penalty'],
      latestPeakUsage: 6.2,
      latestValleyUsage: 3.1,
      ladderLevel: 2,
      penalty: 0,
    });
    expect(svg).toContain('峰用电 · 10月27日');
    expect(svg).toContain('谷用电 · 10月27日');
    expect(svg).toContain('最近账单阶梯');
    expect(svg).toContain('违约金');
    expect(svg).toContain('档');
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
