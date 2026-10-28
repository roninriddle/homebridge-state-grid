/**
 * JCE/Tars 二进制写入器，复刻 recovered Turing 信封的线上格式。
 *
 * 字段顺序是从 ARM64 实现里还原出来的，`rawStruct` 的 tag 和结束标记都必须
 * 按原顺序写出——JCE 解码器虽然按语义解析，但服务端会校验签名前的原始字节
 * 形态，所以顺序属于协议的一部分。
 */

import { createPublicKey, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { xxteaEncrypt as xxteaEncryptLocal } from './xxtea.js';

export const TYPE = {
  BYTE: 0,
  SHORT: 1,
  INT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  STRING1: 6,
  STRING4: 7,
  MAP: 8,
  LIST: 9,
  STRUCT_BEGIN: 10,
  STRUCT_END: 11,
  ZERO_TAG: 12,
  SIMPLE_LIST: 13,
} as const;

export const STATIC_KEY = Buffer.from('HtIs!oM*4d4zcDf^', 'utf8');

const TURING_RSA_PUBLIC_KEY_B64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtZX4OooO48FiYa3fwzU+' +
  'fhPHO3YsMBP1MiV1Kp+osNDDPtf4EPCjuzI75ea+8Dbq8uQeCXWszSpWUWH1c2F' +
  '0khl5BOCzDLyd166i4Hnh3jWW3PNu9ETh81aZh9c353U+c2fok/nPcepmGm3jl3' +
  'GZrcxpN9/2wYcCl+t0TWRz+PuTNn0X8/Uf4inmxUJDWclZhao8oYKZM09rH6LRY' +
  'ZiszAV9HpO3b9OFd0+/BARTqd+qUbfObMh3jGvIQUjsbpIT+ttPlqS4RyiVPUVG1' +
  'gyYuS+/XNXbB59MkMlorIzj7esvC96F5OY5nKl7hvruFfHvEpbo4OL4jmveAMUgu' +
  '4cSJQIDAQAB';

export class JceWriter {
  private readonly chunks: Buffer[] = [];

  head(tag: number, typeId: number): void {
    if (!Number.isInteger(tag) || tag < 0 || tag > 255) {
      throw new RangeError('JCE tag must fit in one byte');
    }
    if (tag < 15) {
      this.chunks.push(Buffer.from([(tag << 4) | typeId]));
    } else {
      this.chunks.push(Buffer.from([0xf0 | typeId, tag]));
    }
  }

  zero(tag: number): void {
    this.head(tag, TYPE.ZERO_TAG);
  }

  byte(tag: number, value: number): void {
    if (value === 0) {
      this.zero(tag);
      return;
    }
    this.head(tag, TYPE.BYTE);
    const buf = Buffer.allocUnsafe(1);
    buf.writeInt8(value, 0);
    this.chunks.push(buf);
  }

  short(tag: number, value: number): void {
    if (value >= -128 && value <= 127) {
      this.byte(tag, value);
      return;
    }
    this.head(tag, TYPE.SHORT);
    const buf = Buffer.allocUnsafe(2);
    buf.writeInt16BE(value, 0);
    this.chunks.push(buf);
  }

  int32(tag: number, value: number): void {
    if (value >= -32768 && value <= 32767) {
      this.short(tag, value);
      return;
    }
    this.head(tag, TYPE.INT);
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32BE(value, 0);
    this.chunks.push(buf);
  }

  int64(tag: number, value: number | bigint): void {
    const big = typeof value === 'bigint' ? value : BigInt(value);
    if (big >= -2147483648n && big <= 2147483647n) {
      this.int32(tag, Number(big));
      return;
    }
    this.head(tag, TYPE.LONG);
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigInt64BE(big, 0);
    this.chunks.push(buf);
  }

  string(tag: number, value: string | Buffer): void {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (raw.length <= 255) {
      this.head(tag, TYPE.STRING1);
      this.chunks.push(Buffer.from([raw.length]));
    } else {
      this.head(tag, TYPE.STRING4);
      const len = Buffer.allocUnsafe(4);
      len.writeInt32BE(raw.length, 0);
      this.chunks.push(len);
    }
    this.chunks.push(raw);
  }

  mapIntString(tag: number, entries: Iterable<readonly [number, string]>): void {
    const items = [...entries];
    this.head(tag, TYPE.MAP);
    this.int32(0, items.length);
    for (const [key, value] of items) {
      this.int32(0, key);
      this.string(1, value);
    }
  }

  rawStruct(tag: number, fields: Buffer): void {
    this.head(tag, TYPE.STRUCT_BEGIN);
    this.chunks.push(fields);
    this.head(0, TYPE.STRUCT_END);
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface M90Fields {
  channel: string;
  brand: string;
  model: string;
  timestampMs: number;
  cacheFlag: number;
  nestedFields: Buffer;
  contextValue?: string | null;
  statusCode?: number | null;
  statusText?: string | null;
  extraField?: string | null;
}

const TOP_LEVEL_ENTRIES = (model: string, brand: string, channel: string, context?: string | null) => {
  const entries: Array<readonly [number, string]> = [
    [2, model],
    [1, brand],
    [3, channel],
  ];
  if (context) entries.push([4, context]);
  return entries;
};

/** mode-0 顶层对象（无 tag 4 嵌套体）。 */
export function serializeM90Minimal(
  fields: Omit<M90Fields, 'nestedFields' | 'statusCode' | 'statusText' | 'extraField'> & {
    baseToken: string;
  },
): Buffer {
  const writer = new JceWriter();
  writer.mapIntString(0, TOP_LEVEL_ENTRIES(fields.model, fields.brand, fields.channel, fields.contextValue));
  writer.int64(1, fields.timestampMs);
  if (fields.cacheFlag) writer.int32(2, fields.cacheFlag);
  writer.string(3, fields.baseToken);
  return writer.finish();
}

/** mode-1 顶层对象：tag 4 携带完整嵌套体。 */
export function serializeM90Full(fields: M90Fields): Buffer {
  const writer = new JceWriter();
  writer.mapIntString(
    0,
    TOP_LEVEL_ENTRIES(fields.model, fields.brand, fields.channel, fields.contextValue),
  );
  writer.int64(1, fields.timestampMs);
  if (fields.cacheFlag) writer.int32(2, fields.cacheFlag);
  writer.rawStruct(4, fields.nestedFields);
  if (fields.statusCode) writer.int32(5, fields.statusCode);
  if (fields.statusText) writer.string(6, fields.statusText);
  if (fields.extraField) writer.string(7, fields.extraField);
  return writer.finish();
}

export interface NestedFields {
  timestampMs: number;
  metadata: Record<number, string | number>;
  featureValues?: Iterable<readonly [number, string]>;
  network?: readonly [string, string];
  outerString4?: string;
  directValues?: Iterable<readonly [number, string]>;
  extraMapValues?: Iterable<readonly [number, string]>;
  outerString7?: string;
  type8Values?: Record<number, string | number | Array<[number, string]>>;
}

/** 完整的 tag 0..8 嵌套结构。 */
export function serializeTuringNested(fields: NestedFields): Buffer {
  const out = new JceWriter();
  out.int64(0, fields.timestampMs);

  const meta = new JceWriter();
  meta.int32(0, Number(fields.metadata[0] ?? 90));
  meta.string(1, String(fields.metadata[1] ?? ''));
  meta.string(2, String(fields.metadata[2] ?? ''));
  meta.string(3, String(fields.metadata[3] ?? ''));
  meta.int32(4, Number(fields.metadata[4] ?? 2));
  out.rawStruct(1, meta.finish());

  out.mapIntString(2, fields.featureValues ?? []);

  const net = new JceWriter();
  const [netA, netB] = fields.network ?? ['', ''];
  net.string(0, netA);
  net.string(1, netB);
  out.rawStruct(3, net.finish());

  if (fields.outerString4) out.string(4, fields.outerString4);

  const direct = [...(fields.directValues ?? [])];
  if (direct.length) out.mapIntString(5, direct);

  const extra = [...(fields.extraMapValues ?? [])];
  if (extra.length) out.mapIntString(6, extra);

  if (fields.outerString7) out.string(7, fields.outerString7);

  const v8 = fields.type8Values ?? {};
  const tail = new JceWriter();
  tail.string(0, String(v8[0] ?? ''));
  if (v8[1]) tail.string(1, String(v8[1]));
  tail.string(2, String(v8[2] ?? ''));
  tail.int32(3, Number(v8[3] ?? 0));
  tail.string(4, String(v8[4] ?? ''));
  tail.string(5, String(v8[5] ?? ''));
  if (v8[6]) tail.string(6, String(v8[6]));
  if (v8[7]) tail.string(7, String(v8[7]));
  const tailMap = v8[8] as Array<[number, string]> | undefined;
  if (tailMap && tailMap.length) tail.mapIntString(8, tailMap);
  out.rawStruct(8, tail.finish());

  return out.finish();
}

function deflateWithMarker(nativeBlob: Buffer): Buffer {
  return deflateSync(Buffer.concat([Buffer.from([0x02]), nativeBlob]));
}

/** mode-0 信封：`v3:` + base64(0x00 || ts || XXTEA(zlib))。 */
export function encodeMode0(nativeBlob: Buffer, timestampMs: number): string {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(timestampMs), 0);
  const key = Buffer.concat([STATIC_KEY, timestamp]);
  const cipher = xxteaEncryptLocal(deflateWithMarker(nativeBlob), key);
  return `v3:${Buffer.concat([Buffer.from([0x00]), timestamp, cipher]).toString('base64')}`;
}

/** mode-1 信封：`v3:` + base64(0x01 || RSA(key) || XXTEA(zlib))。 */
export function encodeMode1(nativeBlob: Buffer, randomKey?: Buffer): string {
  const key = randomKey ?? randomKey16();
  if (key.length !== 16) throw new Error('mode-1 key must be exactly 16 bytes');
  const cipher = xxteaEncryptLocal(deflateWithMarker(nativeBlob), key);
  const packed = Buffer.concat([Buffer.from([0x01]), rsaPkcs1Encrypt(key), cipher]);
  return `v3:${packed.toString('base64')}`;
}

let cachedRsaKey: ReturnType<typeof createPublicKey> | null = null;

function rsaPublicKey(): ReturnType<typeof createPublicKey> {
  if (!cachedRsaKey) {
    const body = TURING_RSA_PUBLIC_KEY_B64.match(/.{1,64}/g)?.join('\n') ?? '';
    cachedRsaKey = createPublicKey(`-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`);
  }
  return cachedRsaKey;
}

/** PKCS#1 v1.5 加密；填充由 OpenSSL 随机生成，与上游 Python 行为等价。 */
export function rsaPkcs1Encrypt(message: Buffer): Buffer {
  return publicEncrypt(
    { key: rsaPublicKey(), padding: constants.RSA_PKCS1_PADDING },
    message,
  );
}

function randomKey16(): Buffer {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = Buffer.alloc(16);
  const random = randomBytes(16);
  for (let i = 0; i < 16; i++) bytes[i] = alphabet.charCodeAt(random[i] % alphabet.length);
  return bytes;
}
