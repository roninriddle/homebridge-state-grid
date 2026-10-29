/**
 * 摄像头链路的纯算法自测：SRTP 加解密、NAL 切分、RTP 打包。
 *
 * 这些是最容易写错又最难在真机上调的部分（HomeKit 只会表现出黑屏或花屏），
 * 所以在本地用可验证的等价断言把它们钉死。
 */

import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

import { deriveSessionKeys, protectRtp, unprotectRtp } from '../src/camera/srtp.js';
import { MAX_PAYLOAD, nalType, packetizeNal, splitNalUnits } from '../src/camera/rtp.js';

const keys = {
  masterKey: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  masterSalt: Buffer.from('fedcba9876543210fedcba987654', 'hex'),
};

describe('SRTP', () => {
  const session = deriveSessionKeys(keys);

  it('符合 RFC 3711 B.3 三项标准向量', () => {
    const result = deriveSessionKeys({ masterKey: Buffer.from('E1F97A0D3E018BE0D64FA32C06DE4139', 'hex'), masterSalt: Buffer.from('0EC675AD498AFEEBB6960B3AABE6', 'hex') });
    expect(result.sessionKey.toString('hex')).toBe('c61e7a93744f39ee10734afe3ff7a087');
    expect(result.sessionSalt.toString('hex')).toBe('30cbbc08863d8c85d49db34a9ae1');
    expect(result.sessionAuthKey.toString('hex')).toBe('cebe321f6ff7716b6fd4ab49af256a156d38baa4');
  });
  it('包序号回绕后使用增长的 ROC', () => {
    const header = Buffer.from('806300010000000000000001', 'hex'); const payload = Buffer.from('rollover');
    const first = protectRtp({header, payload}, session, 1, 1);
    const second = protectRtp({header, payload}, session, 1, 65537);
    expect(first.equals(second)).toBe(false);
    expect(unprotectRtp(second, session, 12, 1, 65537).payload).toEqual(payload);
    expect(() => unprotectRtp(second, session, 12, 1, 1)).toThrow();
  });
  it('派生出固定长度的会话密钥', () => {
    expect(session.sessionKey.length).toBe(16);
    expect(session.sessionSalt.length).toBe(14);
    expect(session.sessionAuthKey.length).toBe(20);
  });

  it('加解密可还原，且认证标签为 10 字节', () => {
    const header = Buffer.from('800000010000000000000001', 'hex');
    const payload = Buffer.from('hello homekit video payload');
    const packet = protectRtp({ header, payload }, session, 0x12345678, 7);

    // AES-CTR 保持原始载荷长度。
    expect(packet.length).toBe(header.length + payload.length + 10);

    const opened = unprotectRtp(packet, session, header.length, 0x12345678, 7);
    expect(opened.header.equals(header)).toBe(true);
    // 接收方必须得到原始载荷。
    expect(opened.payload.equals(payload)).toBe(true);
  });

  it('认证标签被篡改时拒绝接受', () => {
    const header = Buffer.from('800000010000000000000001', 'hex');
    const packet = protectRtp({ header, payload: Buffer.from('abc') }, session, 1, 1);
    packet[packet.length - 1] ^= 0xff;
    expect(() => unprotectRtp(packet, session, header.length, 1, 1)).toThrow();
  });

  it('不同包序号产生不同密文', () => {
    const header = Buffer.from('800000010000000000000001', 'hex');
    const payload = Buffer.alloc(32, 9);
    const a = protectRtp({ header, payload }, session, 1, 1);
    const b = protectRtp({ header, payload }, session, 1, 2);
    expect(a.equals(b)).toBe(false);
  });
});

describe('NAL 切分', () => {
  it('切出完整 NAL 并保留未完成尾巴', () => {
    const stream = Buffer.concat([
      Buffer.from([0, 0, 0, 1, 0x67, 0xaa]),
      Buffer.from([0, 0, 0, 1, 0x68, 0xbb]),
      Buffer.from([0, 0, 0, 1, 0x65, 0xcc, 0xdd]),
      Buffer.from([0, 0, 0, 1, 0x41]),
    ]);
    const { nals, rest } = splitNalUnits(stream);
    expect(nals.length).toBe(3);
    expect(nalType(nals[0])).toBe(7);
    expect(nalType(nals[1])).toBe(8);
    expect(nalType(nals[2])).toBe(5);
    expect(rest.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))).toBe(true);
  });

  it('数据不足时全部留到下一批', () => {
    const { nals, rest } = splitNalUnits(Buffer.from([0, 0, 0, 1, 0x67]));
    expect(nals.length).toBe(0);
    expect(rest.length).toBe(5);
  });
});

describe('RTP 打包', () => {
  it('小 NAL 打成单包并置 marker', () => {
    const nal = Buffer.from([0x65, 1, 2, 3]);
    const { packets, nextSequence } = packetizeNal(nal, {
      payloadType: 99,
      sequenceNumber: 100,
      timestamp: 9000,
      ssrc: 42,
    });
    expect(packets.length).toBe(1);
    expect(nextSequence).toBe(101);
    expect(packets[0].marker).toBe(true);
    // marker 位在 RTP 第二字节最高位。
    expect(packets[0].header[1] & 0x80).toBe(0x80);
    expect(packets[0].payload.equals(nal)).toBe(true);
  });

  it('大 NAL 用 FU-A 分片，只有最后一包置 marker', () => {
    const nal = Buffer.concat([Buffer.from([0x65]), randomBytes(MAX_PAYLOAD * 2 + 500)]);
    const { packets, nextSequence } = packetizeNal(nal, {
      payloadType: 99,
      sequenceNumber: 1,
      timestamp: 9000,
      ssrc: 42,
    });
    expect(packets.length).toBe(3);
    expect(nextSequence).toBe(4);
    expect(packets.filter((packet) => packet.marker).length).toBe(1);
    expect(packets[packets.length - 1].marker).toBe(true);
    // FU-A 类型为 28，起始包标 0x80。
    expect(packets[0].payload[0] & 0x1f).toBe(28);
    expect(packets[0].payload[1] & 0x80).toBe(0x80);
    expect(packets[1].payload[1] & 0x80).toBe(0);
    expect(packets[2].payload[1] & 0x40).toBe(0x40);
    // 分片拼回去要等于原始 NAL 去掉首字节。
    const reassembled = Buffer.concat(packets.map((packet) => packet.payload.subarray(2)));
    expect(reassembled.equals(nal.subarray(1))).toBe(true);
  });
});
