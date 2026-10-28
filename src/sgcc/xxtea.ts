/**
 * XXTEA，复刻 `Quarenden.a`（含其内嵌长度字的特殊布局）。
 *
 * 与教科书 XXTEA 的差异：分组数按 `len/4 + (len%4 ? 2 : 1)` 计算，且最后一个
 * 字固定写入明文长度。这两点必须保持，否则密文与服务端解不开。
 */

import { createHash } from 'node:crypto';

const DELTA = 0x9e3779b9;
const DEFAULT_KEY = Buffer.from('DFG#$%^#%$RGHR(&*M<><', 'utf8');

function toKeyWords(keyBytes: Buffer | null): Uint32Array {
  let material = keyBytes ?? DEFAULT_KEY;
  if (material.length > 16) {
    material = createHash('md5').update(material).digest();
  }
  const padded = Buffer.alloc(16);
  material.copy(padded, 0, 0, Math.min(material.length, 16));
  const words = new Uint32Array(4);
  for (let i = 0; i < 4; i++) words[i] = padded.readUInt32LE(i * 4);
  return words;
}

function mx(sum: number, y: number, z: number, p: number, e: number, key: Uint32Array): number {
  const a = ((z >>> 5) ^ ((y << 2) >>> 0)) + ((y >>> 3) ^ ((z << 4) >>> 0));
  const b = (y ^ sum) + (z ^ key[(p & 3) ^ e]);
  return (a ^ b) >>> 0;
}

export function xxteaEncrypt(plain: Buffer, keyBytes: Buffer | null): Buffer {
  if (plain.length === 0) return plain;

  const count = Math.floor(plain.length / 4) + (plain.length % 4 === 0 ? 1 : 2);
  const values = new Uint32Array(count);
  for (let index = 0; index < plain.length; index++) {
    values[Math.floor(index / 4)] |= plain[index] << ((index % 4) * 8);
  }
  values[count - 1] = plain.length;

  const n = count - 1;
  const key = toKeyWords(keyBytes);
  let rounds = 6 + Math.floor(52 / (n + 1));
  let sum = 0;
  let z = values[n];

  while (rounds > 0) {
    sum = (sum + DELTA) >>> 0;
    const e = (sum >>> 2) & 3;
    let p = 0;
    for (; p < n; p++) {
      const y = values[p + 1];
      values[p] = (values[p] + mx(sum, y, z, p, e, key)) >>> 0;
      z = values[p];
    }
    const y = values[0];
    values[n] = (values[n] + mx(sum, y, z, n, e, key)) >>> 0;
    z = values[n];
    rounds--;
  }

  const out = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) out.writeUInt32LE(values[i], i * 4);
  return out;
}

/** 仅供测试与诊断使用：逆运算，用于验证密文可还原。 */
export function xxteaDecrypt(cipher: Buffer, keyBytes: Buffer | null): Buffer {
  if (cipher.length === 0) return cipher;
  if (cipher.length % 4 !== 0) throw new Error('XXTEA ciphertext must be word aligned');

  const count = cipher.length / 4;
  const values = new Uint32Array(count);
  for (let i = 0; i < count; i++) values[i] = cipher.readUInt32LE(i * 4);

  const n = count - 1;
  const key = toKeyWords(keyBytes);
  let rounds = 6 + Math.floor(52 / (n + 1));
  let sum = (rounds * DELTA) >>> 0;
  let y = values[0];

  while (sum !== 0) {
    const e = (sum >>> 2) & 3;
    let p = n;
    for (; p > 0; p--) {
      const z = values[p - 1];
      values[p] = (values[p] - mx(sum, y, z, p, e, key)) >>> 0;
      y = values[p];
    }
    const z = values[n];
    values[0] = (values[0] - mx(sum, y, z, 0, e, key)) >>> 0;
    y = values[0];
    sum = (sum - DELTA) >>> 0;
    rounds--;
    if (rounds < 0) break;
  }

  const length = values[n];
  if (length > n * 4) throw new Error('XXTEA length word out of range');
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) out.writeUInt32LE(values[i], i * 4);
  return out.subarray(0, length);
}
