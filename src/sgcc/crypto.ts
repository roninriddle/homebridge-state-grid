/**
 * 网上国网 App 3.2.3 的请求/响应信封。
 *
 * 实测结论（见 tests/crypto.test.ts）：
 *  - SM4 为 ECB + PKCS7，密钥取 32 位十六进制串的**前 16 个 ASCII 字符**，
 *    不做 hex 解码；密文大写。Node 原生 `sm4-ecb` 即可，无需第三方实现。
 *  - SM3 直接用 Node 原生 `sm3`；签名是对「十六进制文本」做哈希，不是对字节。
 *  - SM2 只用于包装 32 字符密钥，mode 为 C1C3C2，无签名/证书/ASN.1。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import smCrypto from 'sm-crypto';

export const SERVER_PUBLIC_KEY_HEX = (
  '0409C10D38CF7B4E28097EAAA519E3157C9B4E72194CD13BD11932CE40ED5624A' +
  'FEFF27F78893E4C4FC2029DA147AB6CEAE0CDC8E3A547EFCDC5AB91757FE1CA60'
).toUpperCase();

export const CLIENT_PRIVATE_KEY_HEX =
  '50C4AF48DF75808050729977AA6BC127DC21A404755C660B94222F9D50FA4A75';

const HEX_32 = /^[0-9a-fA-F]{32}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const HEX_128 = /^[0-9a-fA-F]{128}$/;
const HEX_130 = /^04[0-9a-fA-F]{128}$/;

/** 与 Gson 一致的紧凑 JSON（无空格、不转义非 ASCII）。 */
export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function generateSm4KeyText(): string {
  return randomBytes(16).toString('hex');
}

function sm4KeyBytes(keyText: string): Buffer {
  if (!HEX_32.test(keyText)) {
    throw new Error('SM4 key text must be exactly 32 hexadecimal characters');
  }
  return Buffer.from(keyText.slice(0, 16), 'ascii');
}

export function sm4EncryptHex(plaintext: string | Buffer, keyText: string): string {
  const raw = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const cipher = createCipheriv('sm4-ecb', sm4KeyBytes(keyText), null);
  return Buffer.concat([cipher.update(raw), cipher.final()]).toString('hex').toUpperCase();
}

export function sm4DecryptHex(ciphertextHex: string, keyText: string): Buffer {
  const decipher = createDecipheriv('sm4-ecb', sm4KeyBytes(keyText), null);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
}

function normalizePublicKey(publicKeyHex: string): string {
  if (HEX_130.test(publicKeyHex)) return publicKeyHex.slice(2);
  if (HEX_128.test(publicKeyHex)) return publicKeyHex;
  throw new Error('SM2 public key must be 128 hex chars, optionally prefixed by 04');
}

export function derivePublicKey(privateKeyHex: string): string {
  if (!HEX_64.test(privateKeyHex)) {
    throw new Error('SM2 private key must be exactly 64 hexadecimal characters');
  }
  const pub = smCrypto.sm2.getPublicKeyFromPrivateKey(privateKeyHex) as string;
  return pub.length === 130 ? pub.slice(2) : pub;
}

/** 用服务端公钥包装请求密钥，返回小写 `04 || C1C3C2`。 */
export function sm2EncryptKey(keyText: string, serverPublicKeyHex: string): string {
  if (!HEX_32.test(keyText)) {
    throw new Error('request key must be a 32-character hexadecimal string');
  }
  // sm-crypto 的 decodePointHex 要求非压缩点必须自带 04 前缀。
  const publicKey = HEX_130.test(serverPublicKeyHex)
    ? serverPublicKeyHex
    : `04${normalizePublicKey(serverPublicKeyHex)}`;
  const encrypted = smCrypto.sm2.doEncrypt(keyText, publicKey, 1) as string;
  return `04${encrypted.toLowerCase()}`;
}

/** 用客户端私钥解开响应体的 `respKey`。 */
export function sm2DecryptKey(wrappedKeyHex: string, clientPrivateKeyHex: string): string {
  if (!HEX_64.test(clientPrivateKeyHex)) {
    throw new Error('SM2 private key must be exactly 64 hexadecimal characters');
  }
  const wire = wrappedKeyHex.toLowerCase().startsWith('04')
    ? wrappedKeyHex.slice(2)
    : wrappedKeyHex;
  const plaintext = smCrypto.sm2.doDecrypt(wire, clientPrivateKeyHex, 1, {
    output: 'string',
  }) as string;
  if (!HEX_32.test(plaintext)) {
    throw new Error('decrypted response key is not 32 hexadecimal characters');
  }
  return plaintext;
}

export function sm3Hex(text: string): string {
  return createHash('sm3').update(text, 'utf8').digest('hex');
}

export function envelopeSign(skey: string, data: string, timestamp: string): string {
  return sm3Hex(skey + data + timestamp);
}

export interface RequestEnvelope {
  data: string;
  sign: string;
  skey: string;
  timestamp: string;
}

export interface EnvelopeOptions {
  serverPublicKey?: string;
  timestamp?: string;
  keyText?: string;
}

export function buildRequestEnvelope(
  payload: unknown,
  options: EnvelopeOptions = {},
): RequestEnvelope {
  const keyText = options.keyText ?? generateSm4KeyText();
  const timestamp = options.timestamp ?? String(Date.now());
  const data = sm4EncryptHex(compactJson(payload), keyText);
  const skey = sm2EncryptKey(keyText, options.serverPublicKey ?? SERVER_PUBLIC_KEY_HEX);
  return { data, sign: envelopeSign(skey, data, timestamp), skey, timestamp };
}

export function decryptResponseEnvelope(
  envelope: { respKey?: unknown; encryptData?: unknown },
  clientPrivateKey: string = CLIENT_PRIVATE_KEY_HEX,
): unknown {
  const keyText = sm2DecryptKey(String(envelope.respKey ?? ''), clientPrivateKey);
  const plaintext = sm4DecryptHex(String(envelope.encryptData ?? ''), keyText);
  return JSON.parse(plaintext.toString('utf8'));
}

export function verifyRequestEnvelope(envelope: Record<string, unknown>): boolean {
  const sign = String(envelope.sign ?? '').toLowerCase();
  return sign === envelopeSign(String(envelope.skey), String(envelope.data), String(envelope.timestamp));
}
