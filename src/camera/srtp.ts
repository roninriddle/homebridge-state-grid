/**
 * SRTP 加密（RFC 3711，AES-128-CM + HMAC-SHA1-80）。
 *
 * HomeKit 的视频流要求 SRTP。`@homebridge/camera-utils` 只负责在 SDP 里协商
 * 加密参数，实际加密封包必须自己做，所以这里实现会话密钥派生、载荷加密和
 * 10 字节认证标签。
 *
 * 只支持 AES_CM_128_HMAC_SHA1_80（HomeKit 摄像头唯一实用的套件）。
 */

import { createCipheriv, createHmac } from 'node:crypto';

const LABEL_RTP_ENCRYPTION = 0x00;
const LABEL_RTP_AUTH = 0x01;
const LABEL_RTP_SALT = 0x02;

export interface SrtpKeys {
  masterKey: Buffer;
  masterSalt: Buffer;
}

export interface SessionKeys {
  sessionKey: Buffer;
  sessionSalt: Buffer;
  sessionAuthKey: Buffer;
}

/**
 * AES-CM 密钥派生。
 *
 * IV = (master_salt << 16) ^ (label << 48) ^ (index DIV key_derivation_rate)，
 * 本项目 key_derivation_rate 为 0，所以 index 恒为 0。
 */
function deriveKey(
  masterKey: Buffer,
  masterSalt: Buffer,
  label: number,
  length: number,
): Buffer {
  const iv = Buffer.alloc(16);
  masterSalt.copy(iv, 0, 0, 14);
  iv[7] ^= label;

  const cipher = createCipheriv('aes-128-ecb', masterKey, null);
  cipher.setAutoPadding(false);
  const zeros = Buffer.alloc(Math.ceil(length / 16) * 16);
  const stream = Buffer.concat([cipher.update(zeros), cipher.final()]);
  return stream.subarray(0, length);
}

export function deriveSessionKeys(keys: SrtpKeys): SessionKeys {
  return {
    sessionKey: deriveKey(keys.masterKey, keys.masterSalt, LABEL_RTP_ENCRYPTION, 16),
    sessionAuthKey: deriveKey(keys.masterKey, keys.masterSalt, LABEL_RTP_AUTH, 20),
    sessionSalt: deriveKey(keys.masterKey, keys.masterSalt, LABEL_RTP_SALT, 14),
  };
}

/**
 * 构造 AES-CM 的 128 位计数器初始值（RFC 3711 4.1.1）。
 *
 * libsrtp 的做法（srtp.c `srtp_protect` + aes_icm.c `aes_icm_set_iv`）：
 *   nonce = [0(2B)] [SSRC(4B)] [ROC(4B)] [SEQ(2B)] [0(2B)]
 *   counter = salt XOR nonce
 * 本项目 key_derivation_rate = 0，ROC 恒为 0，因此：
 *   iv[0..4)  = salt[0..4)
 *   iv[4..8)  = salt[4..8)  XOR SSRC
 *   iv[8..12) = salt[8..12)（ROC=0）
 *   iv[12..14) = salt[12..14) XOR SEQ
 *   iv[14..16) = 0
 */
function counterIv(sessionSalt: Buffer, ssrc: number, seq: number): Buffer {
  const iv = Buffer.alloc(16);
  sessionSalt.copy(iv, 0, 0, 14);
  iv.writeUInt32BE((iv.readUInt32BE(4) ^ (ssrc >>> 0)) >>> 0, 4);
  iv.writeUInt16BE((iv.readUInt16BE(12) ^ (seq & 0xffff)) & 0xffff, 12);
  return iv;
}

export interface RtpPacket {
  header: Buffer;
  payload: Buffer;
}

/**
 * 加密并认证一个完整的 RTP 包。
 *
 * 注意 RTP 头部的 payload length 字段不参与加密，加密从载荷起始开始；
 * 认证覆盖「头部 + 加密后载荷 + ROC」（RFC 3711 4.2：M = Authenticated
 * Portion || ROC，ROC 为 4 字节大端，本项目恒为 0）。
 */
export function protectRtp(
  packet: RtpPacket,
  session: SessionKeys,
  ssrc: number,
  seq: number,
): Buffer {
  const padLength = (16 - (packet.payload.length % 16)) % 16;
  const padded = Buffer.concat([packet.payload, Buffer.alloc(padLength)]);

  const cipher = createCipheriv(
    'aes-128-ctr',
    session.sessionKey,
    counterIv(session.sessionSalt, ssrc, seq),
  );
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  const out = Buffer.concat([packet.header, encrypted]);
  const roc = Buffer.alloc(4);
  const tag = createHmac('sha1', session.sessionAuthKey)
    .update(out)
    .update(roc)
    .digest()
    .subarray(0, 10);
  return Buffer.concat([out, tag]);
}

/** 验证并解出 RTP 包，仅用于自测。 */
export function unprotectRtp(
  protectedPacket: Buffer,
  session: SessionKeys,
  headerLength: number,
  ssrc: number,
  seq: number,
): RtpPacket {
  const body = protectedPacket.subarray(0, protectedPacket.length - 10);
  const tag = protectedPacket.subarray(protectedPacket.length - 10);
  const roc = Buffer.alloc(4);
  const expected = createHmac('sha1', session.sessionAuthKey)
    .update(body)
    .update(roc)
    .digest()
    .subarray(0, 10);
  if (!tag.equals(expected)) throw new Error('SRTP 认证标签不匹配');

  const header = body.subarray(0, headerLength);
  const encrypted = body.subarray(headerLength);
  const decipher = createCipheriv(
    'aes-128-ctr',
    session.sessionKey,
    counterIv(session.sessionSalt, ssrc, seq),
  );
  decipher.setAutoPadding(false);
  const payload = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return { header, payload };
}
