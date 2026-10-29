/**
 * 用电卡片的 SVG 生成。
 *
 * 刻意只输出矢量字符串：渲染成位图是下一步的事。这样模板可以单测、
 * 可以在浏览器里预览，也不依赖任何栅格化库的 API 细节。
 *
 * 版式由 `fields` 驱动：
 *  - 第 1 个字段是卡片主数字（大字，账户余额 / 应交电费）；
 *  - 第 2 个字段与主数字并列（大字，默认是本月预估电费）；
 *  - 其余字段进入自适应网格，列数、占位和字号随字段数量调整。
 * 缺数据的字段不隐藏，统一显示「—」，保证布局稳定。
 */

import { escapeXml, formatClock, formatDayMonth, formatMoney, formatNumber, formatUsage } from './format.js';
import { DEFAULT_FIELD_ORDER, FIELD_META, type FieldKey, type FieldUnit } from './fields.js';

export type CardTheme = 'light' | 'dark';

export interface FieldValue {
  key: FieldKey;
  label: string;
  value?: number;
  unit: FieldUnit;
  estimated?: boolean;
}

export interface CardData {
  title: string;
  region?: string;
  /** 主数字：预付费显示余额，后付费显示应交。 */
  primaryValue?: number;
  primaryLabel: string;
  latestDailyUsage?: number;
  latestDailyDate?: string;
  currentMonthUsage?: number;
  currentMonthThrough?: string;
  currentMonthPartial?: boolean;
  latestMonth?: string;
  /** 本月电费估算，基于上月结算均价。 */
  monthEstimateCharge?: number;
  latestMonthUsage?: number;
  latestMonthCharge?: number;
  currentYearUsage?: number;
  currentYearCharge?: number;
  latestPeakUsage?: number;
  latestValleyUsage?: number;
  latestFlatUsage?: number;
  latestSharpUsage?: number;
  monthPeakUsage?: number;
  monthValleyUsage?: number;
  monthFlatUsage?: number;
  monthSharpUsage?: number;
  ladderLevel?: number;
  penalty?: number;
  historyOwe?: number;
  dailySeries: Array<{ date: string; usage: number }>;
  updatedAt: number;
  /** 展示哪些字段、按什么顺序。缺省用默认顺序。 */
  fields?: FieldKey[];
  /** 数据未及时更新时的提示。 */
  staleNote?: string;
  theme?: CardTheme;
}

interface Palette {
  bg: string; card: string; tile: string; stroke: string; text: string;
  secondary: string; accent: string; divider: string; accentSoft: string;
}
const PALETTES: Record<CardTheme, Palette> = {
  light: {bg: '#EEF3F6', card: '#FFFFFF', tile: '#F3F7F8', stroke: '#DFE8EC', text: '#18313D', secondary: '#6C818D', accent: '#007F73', divider: '#E5ECEF', accentSoft: '#E6F5F1'},
  dark: {bg: '#0B1118', card: '#111D29', tile: '#192A38', stroke: '#263C4C', text: '#F1F7FA', secondary: '#94AABA', accent: '#4BDAC2', divider: '#29404F', accentSoft: '#163C3A'},
};
const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif";
function text(x: number, y: number, content: string, size: number, fill: string, weight = 400, anchor: 'start' | 'middle' | 'end' = 'start'): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(content)}</text>`;
}
function numericWidth(value: string): number {
  return [...value].reduce((sum, ch) => sum + (ch === '.' || ch === ',' ? .28 : ch === '—' ? .9 : .59), 0);
}
function fittedSize(value: string, desired: number, available: number): number {
  return Math.max(16, Math.min(desired, Math.floor(available / Math.max(1, numericWidth(value)))));
}
function labelFor(field: FieldValue): string {
  return field.label + (field.estimated && !/预估|估算/.test(field.label) ? ' · 估算' : '');
}
function fieldValues(data: CardData): FieldValue[] {
  const order = data.fields?.length ? data.fields : DEFAULT_FIELD_ORDER;
  const values: Record<FieldKey, number | undefined> = {
    balance: data.primaryValue, monthEstimateCharge: data.monthEstimateCharge,
    currentMonthUsage: data.currentMonthUsage, latestDailyUsage: data.latestDailyUsage,
    latestPeakUsage: data.latestPeakUsage, latestValleyUsage: data.latestValleyUsage,
    latestFlatUsage: data.latestFlatUsage, latestSharpUsage: data.latestSharpUsage,
    latestMonthUsage: data.latestMonthUsage, latestMonthCharge: data.latestMonthCharge,
    currentYearUsage: data.currentYearUsage, currentYearCharge: data.currentYearCharge,
    monthPeakUsage: data.monthPeakUsage, monthValleyUsage: data.monthValleyUsage,
    monthFlatUsage: data.monthFlatUsage, monthSharpUsage: data.monthSharpUsage,
    ladderLevel: data.ladderLevel, penalty: data.penalty, historyOwe: data.historyOwe,
  };
  return order.map((key) => {
    const meta = FIELD_META[key];
    let label = key === 'balance' ? data.primaryLabel || meta.label : meta.label;
    if (key === 'latestDailyUsage' && data.latestDailyDate) label = `用电 · ${formatDayMonth(data.latestDailyDate)}`;
    if (key.startsWith('latest') && key.endsWith('Usage') && key !== 'latestMonthUsage' && key !== 'latestDailyUsage' && data.latestDailyDate) label = `${meta.label.replace('上日', '')} · ${formatDayMonth(data.latestDailyDate)}`;
    if (key === 'currentMonthUsage' && data.currentMonthPartial) label = '当月已取电量 · 部分';
    if (key === 'ladderLevel') label = '最近账单阶梯';
    return {key, label, value: values[key], unit: meta.unit, estimated: meta.estimated};
  });
}
function formatField(field: FieldValue): string {
  return field.unit === '元' ? formatMoney(field.value) : field.unit === '档' ? formatNumber(field.value, 0) : formatUsage(field.value);
}

export interface MetricLayout { x: number; y: number; width: number; height: number; valueSize: number; }
/** 最后一行也铺满可用宽度，删去指标后不保留空槽。 */
export function metricLayout(count: number): MetricLayout[] {
  if (count <= 0) return [];
  const columns = count <= 3 ? count : count === 4 ? 2 : count <= 6 ? 3 : count <= 8 ? 4 : count === 9 ? 3 : 4;
  const rows = Math.ceil(count / columns);
  const gap = 14;
  const height = (280 - gap * (rows - 1)) / rows;
  const valueSize = rows === 1 ? (count === 1 ? 88 : count === 2 ? 84 : 76) : rows === 2 ? (columns === 2 ? 66 : columns === 3 ? 62 : 56) : rows === 3 ? (columns === 3 ? 50 : 46) : rows === 4 ? 34 : 25;
  return Array.from({length: count}, (_, index) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    const width = (1120 - gap * (inRow - 1)) / inRow;
    return {x: 80 + (index % columns) * (width + gap), y: 368 + row * (height + gap), width, height, valueSize};
  });
}
function heroSize(field: FieldValue, width: number, expanded: boolean): number {
  const reserve = field.unit === '元' ? 46 : 80;
  return fittedSize(formatField(field), expanded ? 148 : 112, width - reserve);
}
function heroField(field: FieldValue, x: number, width: number, expanded: boolean, p: Palette): string {
  const size = heroSize(field, width, expanded);
  const labelY = expanded ? 282 : 185;
  const valueY = expanded ? 447 : 306;
  const value = formatField(field);
  const label = labelFor(field);
  const numberX = x + (field.unit === '元' ? 42 : 0);
  const suffix = field.unit === '元' ? '' : text(numberX + numericWidth(value) * size + 12, valueY, field.unit, 25, p.secondary);
  return `<g data-role="hero" data-field="${field.key}" data-value-size="${size}">
${text(x, labelY, label, 26, p.secondary, 500)}
${field.unit === '元' ? text(x, valueY - 4, '¥', 35, p.secondary, 500) : ''}
${text(numberX, valueY, value, size, p.text, 600)}${suffix}
</g>`;
}
function tile(field: FieldValue, box: MetricLayout, heroLimit: number, p: Palette): string {
  const padding = box.height >= 120 ? 24 : 16;
  const value = formatField(field);
  const desired = Math.min(box.valueSize, heroLimit - 8);
  const size = fittedSize(value, desired, box.width - 2 * padding - 54);
  const labelSize = box.height >= 150 ? 24 : box.height >= 100 ? 22 : box.height >= 75 ? 18 : box.height >= 55 ? 15 : 13;
  const labelY = box.y + box.height * (box.height >= 150 ? .30 : .28);
  const valueY = box.y + box.height * (box.height >= 150 ? .72 : box.height >= 100 ? .79 : box.height >= 75 ? .82 : .90);
  const unitSize = Math.max(12, Math.round(size * .30));
  const label = labelFor(field);
  const fittedLabel = Math.min(labelSize, (box.width - 2 * padding) / Math.max(1, Array.from(label).length));
  return `<g data-role="metric" data-field="${field.key}" data-value-size="${size}" data-width="${box.width}" data-height="${box.height}">
<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="14" fill="${p.tile}"/>
${text(box.x + padding, labelY, label, fittedLabel, p.secondary, 500)}
${text(box.x + padding, valueY, value, size, p.text, 600)}
${text(box.x + padding + numericWidth(value) * size + 10, valueY, field.unit, unitSize, p.secondary)}
</g>`;
}
export function renderCard(data: CardData): string {
  const p = PALETTES[data.theme ?? 'light'];
  const fields = fieldValues(data);
  const heroes = fields.slice(0, 2);
  const metrics = fields.slice(2);
  const expanded = !metrics.length;
  const heroWidth = heroes.length === 1 ? 1120 : 518;
  const heroLimit = Math.min(...heroes.map((field) => heroSize(field, heroWidth, expanded)));
  const status = data.staleNote || `更新 ${formatClock(data.updatedAt)}`;
  const statusWidth = Math.min(476, 46 + [...status].reduce((sum, ch) => sum + (/[^\x00-\xff]/.test(ch) ? 20 : 12), 0));
  const statusX = 1200 - statusWidth;
  const titleSize = Math.min(34, 520 / Math.max(1, Array.from(data.title).length));
  const layout = metricLayout(metrics.length);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="${p.bg}"/>
<rect x="32" y="28" width="1216" height="664" rx="36" fill="${p.card}" stroke="${p.stroke}"/>
<rect x="80" y="66" width="44" height="44" rx="13" fill="${p.accentSoft}"/>
<path d="M105 74 L91 91 H101 L97 104 L113 85 H103 Z" fill="${p.accent}"/>
${text(138, 98, data.title, titleSize, p.text, 600)}
${data.region ? text(138, 121, data.region, 17, p.secondary) : ''}
<rect x="${statusX}" y="70" width="${statusWidth}" height="38" rx="19" fill="${p.tile}"/>
<circle cx="${statusX + 17}" cy="89" r="4" fill="${data.staleNote ? '#D99A27' : p.accent}"/>
${text(1185, 96, status, data.staleNote ? 18 : 20, p.secondary, 400, 'end')}
<line x1="80" y1="137" x2="1200" y2="137" stroke="${p.divider}"/>
${heroes.map((field, index) => heroField(field, index ? 682 : 80, heroWidth, expanded, p)).join('')}
${heroes.length > 1 ? `<line x1="640" y1="${expanded ? 220 : 174}" x2="640" y2="${expanded ? 510 : 316}" stroke="${p.divider}"/>` : ''}
${metrics.length ? `<line x1="80" y1="344" x2="1200" y2="344" stroke="${p.divider}"/>` : ''}
${metrics.map((field, index) => tile(field, layout[index], heroLimit, p)).join('')}
</svg>`;
}
export function renderCompactCard(data: CardData): string { return renderCard(data); }
export function renderDetailCard(data: CardData): string { return renderCard(data); }
