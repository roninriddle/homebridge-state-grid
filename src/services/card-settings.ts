/** Homebridge 原生保存与卡片按钮共用的设置格式。 */
import { createHash } from 'node:crypto';
import { FIELD_KEYS, normalizeFieldOrder, type FieldKey } from '../renderer/fields.js';
import type { AccountAppearance } from './appearance.js';

export interface CardSettings {
  fields: FieldKey[];
  appearance: Record<string, AccountAppearance>;
  revision: string;
}

export function normalizeCardSettings(value: any): CardSettings {
  if (!Array.isArray(value?.fields) || !value.fields.length || !value.fields.every((key: unknown) => FIELD_KEYS.includes(key as FieldKey))) throw new Error('请至少保留一个有效指标');
  if (value.appearance && (typeof value.appearance !== 'object' || Array.isArray(value.appearance))) throw new Error('名称与地区设置格式无效');
  const fields = normalizeFieldOrder(value.fields);
  const appearance: Record<string, AccountAppearance> = {};
  for (const key of Object.keys(value.appearance || {}).sort()) {
    if (!/^[\w-]{1,128}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('户号格式无效');
    const item = value.appearance[key];
    const name = typeof item?.name === 'string' ? item.name.trim() || '国家电网' : '国家电网';
    if (Array.from(name).length < 2 || Array.from(name).length > 32 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('摄像头名称需为 2～32 个字符');
    if (typeof item?.showRegion !== 'boolean') throw new Error('请选择是否显示地区');
    appearance[key] = {name, showRegion: item.showRegion};
  }
  const revision = createHash('sha256').update(JSON.stringify({fields, appearance})).digest('hex');
  return {fields, appearance, revision};
}
