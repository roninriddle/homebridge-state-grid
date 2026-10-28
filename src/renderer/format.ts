/** 卡片数值格式化。缺失值统一显示为破折号，绝不显示 0。 */

export function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function formatMoney(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function formatDayMonth(iso: string | undefined): string {
  if (!iso) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return '';
  return `${Number(match[2])}月${Number(match[3])}日`;
}

/** 把 kWh 数字压缩成卡片上更易读的形态。 */
export function formatUsage(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value >= 1000 ? value.toFixed(1) : value.toFixed(2);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
