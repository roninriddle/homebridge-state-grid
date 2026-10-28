/**
 * DEFLATE 跨实现兼容性。
 *
 * 上游用 Python zlib 压缩，本插件用 Node zlib 压缩。两者的输出字节**不保证**
 * 相同（本机实测差 2 字节），因为 DEFLATE 允许不同的合法编码选择。服务端只
 * 负责解压，所以协议上等价，但这里固定住这个结论，避免以后误改。
 */

import { describe, it, expect } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const golden = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'golden-vectors.json'), 'utf8'),
) as { m90_hex: string; mode1_components: { deflated_hex: string } };

describe('DEFLATE 兼容性', () => {
  const payload = Buffer.from(`02${golden.m90_hex}`, 'hex');

  it('Node 压缩结果可被自身解压还原', () => {
    expect(inflateSync(deflateSync(payload)).equals(payload)).toBe(true);
  });

  it('Python 的压缩流可被 Node 解压还原', () => {
    const pythonDeflated = Buffer.from(golden.mode1_components.deflated_hex, 'hex');
    expect(inflateSync(pythonDeflated).equals(payload)).toBe(true);
  });

  it('两侧压缩流长度接近，但不要求逐字节相同', () => {
    const pythonDeflated = Buffer.from(golden.mode1_components.deflated_hex, 'hex');
    const nodeDeflated = deflateSync(payload);
    expect(Math.abs(nodeDeflated.length - pythonDeflated.length)).toBeLessThan(8);
  });
});
