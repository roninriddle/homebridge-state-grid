/**
 * 用电卡片的 SVG 生成。
 *
 * 刻意只输出矢量字符串：渲染成位图是下一步的事。这样模板可以单测、
 * 可以在浏览器里预览，也不依赖任何栅格化库的 API 细节。
 *
 * 版式由 `fields` 驱动：
 *  - 第 1 个字段是卡片主数字（大字，账户余额 / 应交电费）；
 *  - 第 2 个字段与主数字并列（大字，默认是本月预估电费）；
 *  - 其余字段进入下方 4 列网格，行数与字号随字段数量自适应。
 * 缺数据的字段不隐藏，统一显示「—」，保证布局稳定。
 */

import { escapeXml, formatClock, formatMoney, formatNumber, formatUsage } from './format.js';
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
  /** 主数字：预付费显示余额，后付费显示应交。 */
  primaryValue?: number;
  primaryLabel: string;
  latestDailyUsage?: number;
  latestDailyDate?: string;
  currentMonthUsage?: number;
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
  bg: string;
  card: string;
  stroke: string;
  text: string;
  secondary: string;
  accent: string;
  divider: string;
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
  },
  dark: {
    bg: '#000000',
    card: '#1C1C1E',
    stroke: '#38383A',
    text: '#FFFFFF',
    secondary: '#8E8E93',
    accent: '#0A84FF',
    divider: '#38383A',
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

/** 从 CardData 里按配置顺序取出字段值（缺失字段仍保留，渲染时显示「—」）。 */
function fieldValues(data: CardData): FieldValue[] {
  const order = data.fields?.length ? data.fields : DEFAULT_FIELD_ORDER;
  const values: Record<FieldKey, number | undefined> = {
    balance: data.primaryValue,
    monthEstimateCharge: data.monthEstimateCharge,
    currentMonthUsage: data.currentMonthUsage,
    latestDailyUsage: data.latestDailyUsage,
    latestPeakUsage: data.latestPeakUsage,
    latestValleyUsage: data.latestValleyUsage,
    latestFlatUsage: data.latestFlatUsage,
    latestSharpUsage: data.latestSharpUsage,
    latestMonthUsage: data.latestMonthUsage,
    latestMonthCharge: data.latestMonthCharge,
    currentYearUsage: data.currentYearUsage,
    currentYearCharge: data.currentYearCharge,
    monthPeakUsage: data.monthPeakUsage,
    monthValleyUsage: data.monthValleyUsage,
    monthFlatUsage: data.monthFlatUsage,
    monthSharpUsage: data.monthSharpUsage,
    ladderLevel: data.ladderLevel,
    penalty: data.penalty,
    historyOwe: data.historyOwe,
  };
  return order.map((key) => {
    const meta = FIELD_META[key];
    const label = key === 'balance' ? data.primaryLabel || meta.label : meta.label;
    return { key, label, value: values[key], unit: meta.unit, estimated: meta.estimated };
  });
}

function formatFieldValue(field: FieldValue): string {
  if (field.unit === '元') return formatMoney(field.value);
  if (field.unit === '档') return formatNumber(field.value, 0);
  return formatUsage(field.value);
}

function unitSuffix(field: FieldValue): string {
  return field.unit;
}

/** 主数字 / 并列数字：元带「¥」前缀，其余带单位后缀。 */
function heroField(field: FieldValue | undefined, x: number, p: Palette): string {
  if (!field) {
    return text(x, 336, '—', 84, p.secondary, 600);
  }
  const label = field.label + (field.estimated ? ' · 估算' : '');
  if (field.unit === '元') {
    return (
      text(x, 296, '¥', 40, p.secondary, 400) +
      text(x + 46, 336, formatMoney(field.value), 96, p.text, 600) +
      text(x, 384, label, 30, p.secondary, 400)
    );
  }
  const unit = field.unit === '档' ? '档' : 'kWh';
  return (
    valueWithUnit(x, 336, formatFieldValue(field), unit, 88, p.text, p.secondary) +
    text(x, 384, label, 30, p.secondary, 400)
  );
}

/** 网格格：小字标签 + 数值（带单位后缀）。 */
function tile(
  field: FieldValue | undefined,
  x: number,
  y: number,
  valueSize: number,
  p: Palette,
): string {
  if (!field) return '';
  const label = field.label + (field.estimated ? ' · 估算' : '');
  const labelSize = Math.round(valueSize * 0.5);
  return (
    text(x, y, label, labelSize, p.secondary, 400) +
    valueWithUnit(x, y + valueSize * 1.15, formatFieldValue(field), unitSuffix(field), valueSize, p.text, p.secondary)
  );
}

export function renderCard(data: CardData): string {
  const p = PALETTES[data.theme ?? 'light'];
  const width = 1280;
  const height = 720;
  const cardX = 48;
  const cardY = 48;
  const cardW = width - cardX * 2;
  const cardH = height - cardY * 2;
  const innerX = cardX + 56;
  const rightEdge = cardX + cardW - 56;
  const innerW = rightEdge - innerX;

  const statusText = data.staleNote ? data.staleNote : `更新 ${formatClock(data.updatedAt)}`;
  const fields = fieldValues(data);
  const hero = fields.slice(0, 2);
  const tiles = fields.slice(2);

  // 主数字区：第一个字段占左半，第二个字段（若有）并列右半。
  const midX = width / 2;
  const heroMarkup = [
    heroField(hero[0], innerX, p),
    hero[1]
      ? `<line x1="${midX - 48}" y1="200" x2="${midX - 48}" y2="392" stroke="${p.divider}" stroke-width="1"/>` +
        heroField(hero[1], midX, p)
      : '',
  ].join('');

  // 网格：4 列，行数与字号随字段数量自适应。
  const columns = 4;
  const gridTop = 420;
  const gridBottom = cardY + cardH - 40;
  const gridHeight = gridBottom - gridTop;
  const rows = Math.max(1, Math.ceil(tiles.length / columns));
  const rowHeight = Math.min(88, gridHeight / rows);
  const valueSize = rowHeight > 78 ? 46 : rowHeight > 60 ? 38 : 32;
  const columnWidth = innerW / columns;

  const tileMarkup = tiles
    .map((field, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = innerX + col * columnWidth;
      const y = gridTop + row * rowHeight;
      return tile(field, x, y, valueSize, p);
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${p.bg}"/>
<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="44" fill="${p.card}" stroke="${p.stroke}" stroke-width="1"/>
<circle cx="${innerX + 10}" cy="110" r="10" fill="${p.accent}"/>
${text(innerX + 34, 122, data.title, 40, p.text, 600)}
${text(rightEdge, 118, statusText, 26, p.secondary, 400, 'end')}
<line x1="${innerX}" y1="164" x2="${rightEdge}" y2="164" stroke="${p.divider}" stroke-width="1"/>
${heroMarkup}
<line x1="${innerX}" y1="408" x2="${rightEdge}" y2="408" stroke="${p.divider}" stroke-width="1"/>
${tileMarkup}
</svg>`;
}

/** 兼容旧入口：首页缩略图与视频流都用完整字段卡片。 */
export function renderCompactCard(data: CardData): string {
  return renderCard(data);
}

/** 兼容旧入口：详情看板与首页卡片共用同一套字段版式，仅渲染尺寸不同。 */
export function renderDetailCard(data: CardData): string {
  return renderCard(data);
}
