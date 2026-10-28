/**
 * 用电卡片的 SVG 生成。
 *
 * 刻意只输出矢量字符串：渲染成位图是下一步的事。这样模板可以单测、
 * 可以在浏览器里预览，也不依赖任何栅格化库的 API 细节。
 *
 * 两个版式：
 *  - compact：家庭 App 首页缩略图。信息量必须克制，因为缩略图实际只有
 *    两三百点宽，塞六个数字等于全都看不清。
 *  - detail：点开摄像头后的 1080p 看板，放完整指标和 7 日趋势。
 */

import { escapeXml, formatClock, formatDayMonth, formatMoney, formatUsage } from './format.js';

export type CardTheme = 'light' | 'dark';

export interface CardData {
  title: string;
  /** 主数字：预付费显示余额，后付费显示应交。 */
  primaryValue?: number;
  primaryLabel: string;
  /** 主数字是否为估算值。 */
  primaryEstimated?: boolean;
  latestDailyUsage?: number;
  latestDailyDate?: string;
  currentMonthUsage?: number;
  /** 本月电费估算，基于上月结算均价。 */
  monthEstimateCharge?: number;
  latestMonthUsage?: number;
  latestMonthCharge?: number;
  currentYearUsage?: number;
  currentYearCharge?: number;
  dailySeries: Array<{ date: string; usage: number }>;
  updatedAt: number;
  /** 数据未及时更新时的提示。 */
  staleNote?: string;
  theme?: CardTheme;
}

interface Palette {
  bg: string;
  card: string;
  stroke: string;
  text: string;
  secondary: string;
  accent: string;
  divider: string;
  bar: string;
  muted: string;
}

const PALETTES: Record<CardTheme, Palette> = {
  light: {
    bg: '#F2F2F7',
    card: '#FFFFFF',
    stroke: '#E5E5EA',
    text: '#1C1C1E',
    secondary: '#8E8E93',
    accent: '#0A84FF',
    divider: '#E5E5EA',
    bar: '#0A84FF',
    muted: '#D1D1D6',
  },
  dark: {
    bg: '#000000',
    card: '#1C1C1E',
    stroke: '#38383A',
    text: '#FFFFFF',
    secondary: '#8E8E93',
    accent: '#0A84FF',
    divider: '#38383A',
    bar: '#0A84FF',
    muted: '#2C2C2E',
  },
};

const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif";

function text(
  x: number,
  y: number,
  content: string,
  size: number,
  fill: string,
  weight = 400,
  anchor: 'start' | 'middle' | 'end' = 'start',
): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(content)}</text>`;
}

/** 粗略估算数字串宽度：数字约 0.62em，小数点约 0.32em（宁宽勿窄）。 */
function digitWidth(value: string, size: number): number {
  let width = 0;
  for (const ch of value) {
    if (ch === '.') width += size * 0.32;
    else if (ch === '—' || ch === '-') width += size * 0.5;
    else width += size * 0.62;
  }
  return width;
}

/** 单位后缀跟着数字走，字号更小、颜色更弱。 */
function valueWithUnit(
  x: number,
  y: number,
  value: string,
  unit: string,
  size: number,
  fill: string,
  unitFill: string,
): string {
  const unitSize = Math.round(size * 0.42);
  const offset = Math.round(digitWidth(value, size) + size * 0.14);
  return (
    text(x, y, value, size, fill, 600) +
    text(x + offset, y, unit, unitSize, unitFill, 400)
  );
}

export function renderCompactCard(data: CardData): string {
  const p = PALETTES[data.theme ?? 'light'];
  const width = 1280;
  const height = 720;
  const cardX = 56;
  const cardY = 56;
  const cardW = width - cardX * 2;
  const cardH = height - cardY * 2;
  const pad = 56;
  const innerX = cardX + pad;
  const innerW = cardW - pad * 2;

  const statusText = data.staleNote
    ? data.staleNote
    : `更新 ${formatClock(data.updatedAt)}`;

  const columns = [
    {
      value: formatUsage(data.currentMonthUsage),
      unit: 'kWh',
      label: '本月用电',
    },
    {
      value: formatUsage(data.latestDailyUsage),
      unit: 'kWh',
      label: data.latestDailyDate ? `最近一日 · ${formatDayMonth(data.latestDailyDate)}` : '最近一日',
    },
    {
      value: formatMoney(data.monthEstimateCharge),
      unit: '元',
      label: '本月电费 · 估算',
    },
  ].filter((column) => column.value !== '—');

  const colWidth = innerW / Math.max(columns.length, 1);

  const columnMarkup = columns
    .map((column, index) => {
      const x = innerX + colWidth * index;
      const parts = [
        valueWithUnit(x, 566, column.value, column.unit, 52, p.text, p.secondary),
        text(x, 610, column.label, 24, p.secondary, 400),
      ];
      if (index > 0) {
        parts.unshift(
          `<line x1="${x - 28}" y1="498" x2="${x - 28}" y2="596" stroke="${p.divider}" stroke-width="1"/>`,
        );
      }
      return parts.join('');
    })
    .join('');

  const primaryMarkup =
    data.primaryValue === undefined
      ? text(innerX, 330, '暂无数据', 84, p.secondary, 600) +
        text(innerX, 384, data.primaryLabel, 30, p.secondary, 400)
      : `<g>${text(innerX, 300, '¥', 52, p.secondary, 400)}${text(innerX + 56, 330, formatMoney(data.primaryValue), 132, p.text, 600)}${text(innerX, 384, `${data.primaryLabel}${data.primaryEstimated ? ' · 估算' : ''}`, 30, p.secondary, 400)}</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${p.bg}"/>
<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="44" fill="${p.card}" stroke="${p.stroke}" stroke-width="1"/>
<circle cx="${innerX + 10}" cy="118" r="10" fill="${p.accent}"/>
${text(innerX + 34, 130, data.title, 40, p.text, 600)}
${text(cardX + cardW - pad, 126, statusText, 26, p.secondary, 400, 'end')}
<line x1="${innerX}" y1="176" x2="${cardX + cardW - pad}" y2="176" stroke="${p.divider}" stroke-width="1"/>
${primaryMarkup}
<line x1="${innerX}" y1="446" x2="${cardX + cardW - pad}" y2="446" stroke="${p.divider}" stroke-width="1"/>
${columnMarkup}
</svg>`;
}

function barChart(
  series: Array<{ date: string; usage: number }>,
  x: number,
  y: number,
  width: number,
  height: number,
  p: Palette,
): string {
  const days = series.slice(-7);
  if (!days.length) {
    return text(x + width / 2, y + height / 2, '暂无趋势数据', 24, p.secondary, 400, 'middle');
  }
  const max = Math.max(...days.map((day) => day.usage), 1);
  const gap = 18;
  const barWidth = (width - gap * (days.length - 1)) / days.length;
  const pieces: string[] = [];
  days.forEach((day, index) => {
    const barHeight = Math.max(6, (day.usage / max) * (height - 46));
    const bx = x + index * (barWidth + gap);
    const by = y + height - 34 - barHeight;
    pieces.push(
      `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="${Math.min(8, barWidth / 3).toFixed(1)}" fill="${p.bar}" opacity="${index === days.length - 1 ? '1' : '0.55'}"/>`,
    );
    pieces.push(
      text(
        bx + barWidth / 2,
        y + height,
        day.date.slice(5).replace('-', '/'),
        18,
        p.secondary,
        400,
        'middle',
      ),
    );
  });
  return pieces.join('');
}

function metricBlock(
  x: number,
  y: number,
  label: string,
  value: string,
  unit: string,
  p: Palette,
  estimated = false,
): string {
  return [
    text(x, y, label + (estimated ? ' · 估算' : ''), 24, p.secondary, 400),
    valueWithUnit(x, y + 62, value, unit, 52, p.text, p.secondary),
  ].join('');
}

export function renderDetailCard(data: CardData): string {
  const p = PALETTES[data.theme ?? 'light'];
  const width = 1920;
  const height = 1080;
  const cardX = 64;
  const cardY = 64;
  const cardW = width - cardX * 2;
  const cardH = height - cardY * 2;
  const pad = 72;
  const innerX = cardX + pad;
  const innerW = cardW - pad * 2;
  const bottom = cardY + cardH - pad;
  const rightEdge = cardX + cardW - pad;

  const statusText = data.staleNote ?? `更新 ${formatClock(data.updatedAt)}`;

  // 对齐「网上国网」用电总览的 6 项指标：当月用电 / 日用电 / 年累计用电 /
  // 年累计电费 / 上月用电 / 上月电费（本月预估电费放在顶部主数字旁）。
  const blocks = [
    { label: '当月用电', value: formatUsage(data.currentMonthUsage), unit: 'kWh' },
    { label: '日用电', value: formatUsage(data.latestDailyUsage), unit: 'kWh' },
    { label: '年累计用电', value: formatUsage(data.currentYearUsage), unit: 'kWh' },
    { label: '年累计电费', value: formatMoney(data.currentYearCharge), unit: '元' },
    { label: '上月用电', value: formatUsage(data.latestMonthUsage), unit: 'kWh' },
    { label: '上月电费', value: formatMoney(data.latestMonthCharge), unit: '元' },
  ].filter((block) => block.value !== '—');

  const columns = 3;
  const blockWidth = innerW / columns;
  const firstRowY = 456;
  const rowPitch = 140;
  const rows = Math.max(1, Math.ceil(blocks.length / columns));

  const blockMarkup = blocks
    .map((block, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      return metricBlock(
        innerX + col * blockWidth,
        firstRowY + row * rowPitch,
        block.label,
        block.value,
        block.unit,
        p,
      );
    })
    .join('');

  const divider3 = firstRowY + (rows - 1) * rowPitch + 120;
  const chartTitleY = divider3 + 48;
  const chartY = divider3 + 70;
  const chartHeight = bottom - chartY;

  const midX = innerX + innerW / 2;

  // 顶部主数字区：左侧账户余额/应交电费，右侧并列「本月预估电费」。
  const estimateMarkup =
    data.monthEstimateCharge === undefined
      ? ''
      : `<g>${text(midX, 254, '¥', 40, p.secondary, 400)}${text(midX + 44, 306, formatMoney(data.monthEstimateCharge), 96, p.text, 600)}${text(midX, 360, '本月预估电费', 30, p.secondary, 400)}</g>`;

  const primaryMarkup =
    data.primaryValue === undefined
      ? text(innerX, 300, '暂无数据', 96, p.secondary, 600) +
        text(innerX, 360, data.primaryLabel, 30, p.secondary, 400)
      : `<g>${text(innerX, 254, '¥', 48, p.secondary, 400)}${text(innerX + 52, 306, formatMoney(data.primaryValue), 132, p.text, 600)}${text(innerX, 360, data.primaryLabel, 30, p.secondary, 400)}</g>` +
        (estimateMarkup
          ? `<line x1="${midX - 48}" y1="214" x2="${midX - 48}" y2="366" stroke="${p.divider}" stroke-width="1"/>${estimateMarkup}`
          : '');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${p.bg}"/>
<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="52" fill="${p.card}" stroke="${p.stroke}" stroke-width="1"/>
<circle cx="${innerX + 12}" cy="130" r="12" fill="${p.accent}"/>
${text(innerX + 40, 144, data.title, 48, p.text, 600)}
${text(rightEdge, 138, statusText, 28, p.secondary, 400, 'end')}
<line x1="${innerX}" y1="196" x2="${rightEdge}" y2="196" stroke="${p.divider}" stroke-width="1"/>
${primaryMarkup}
<line x1="${innerX}" y1="404" x2="${rightEdge}" y2="404" stroke="${p.divider}" stroke-width="1"/>
${blockMarkup}
<line x1="${innerX}" y1="${divider3}" x2="${rightEdge}" y2="${divider3}" stroke="${p.divider}" stroke-width="1"/>
${text(innerX, chartTitleY, '最近 7 日用电', 26, p.secondary, 400)}
${barChart(data.dailySeries, innerX, chartY, innerW, chartHeight, p)}
</svg>`;
}
