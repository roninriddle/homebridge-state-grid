/**
 * 设备身份稳定性与 token 结构。
 *
 * 这是线上能否长期免验证的关键：同一份种子必须永远推导出同一台"设备"，
 * 否则每次重启都会被服务端当成新设备要求短信验证。
 */

import { describe, it, expect } from 'vitest';
import { StableProfile, createProfileState, profileFromState } from '../src/sgcc/turing-profile.js';
import { generateDeviceToken } from '../src/sgcc/device-token.js';

const seed = Buffer.alloc(32, 7);

describe('profile 稳定性', () => {
  it('同一份种子推导出完全相同的设备身份', () => {
    const a = new StableProfile(seed).identity();
    const b = new StableProfile(seed).identity();
    expect(a).toEqual(b);
    expect(a.profileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(a.serial).toMatch(/^TUR[0-9A-F]{14}$/);
    // 只要求「本地管理 + 单播」：bit0=0、bit1=1，其余位保留种子值。
    const firstOctet = parseInt(a.wifiMac.slice(0, 2), 16);
    expect(firstOctet & 0x01).toBe(0);
    expect(firstOctet & 0x02).toBe(0x02);
  });

  it('不同种子得到不同身份', () => {
    const a = new StableProfile(seed).identity();
    const b = new StableProfile(Buffer.alloc(32, 8)).identity();
    expect(a.profileId).not.toBe(b.profileId);
  });

  it('序列化再反序列化后身份不变', () => {
    const state = createProfileState();
    const first = profileFromState(state).identity();
    const second = profileFromState(JSON.parse(JSON.stringify(state))).identity();
    expect(first).toEqual(second);
  });
});

describe('device token', () => {
  const profile = new StableProfile(seed);
  const options = { timestampMs: 1_760_000_000_000, nonce: 'A'.repeat(32) };

  it('结构为 v3:base64(0x01 || RSA-2048 || XXTEA)', () => {
    const { token } = generateDeviceToken(profile, options);
    expect(token.startsWith('v3:')).toBe(true);
    const packed = Buffer.from(token.slice(3), 'base64');
    expect(packed[0]).toBe(0x01);
    expect(packed.length).toBeGreaterThan(1 + 256);
    expect((packed.length - 1 - 256) % 4).toBe(0);
  });

  it('相同输入产生相同长度（除 RSA 填充外结构固定）', () => {
    const first = generateDeviceToken(profile, options);
    const second = generateDeviceToken(profile, options);
    expect(first.featureCount).toBe(62);
    expect(first.profileId).toBe(second.profileId);
    expect(Buffer.from(first.token).length).toBe(Buffer.from(second.token).length);
  });

  it('每次生成的 token 都不同（XXTEA 会话密钥随机）', () => {
    const first = generateDeviceToken(profile, options);
    const second = generateDeviceToken(profile, options);
    expect(first.token).not.toBe(second.token);
  });
});
