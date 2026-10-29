import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateGridPlatform } from '../src/platform.js';

async function withDelegate(test: (delegate: any, entry: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'sgcc-hap-'));
  let delegate: any;
  const log = {info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const api = {user: {storagePath: () => dir}, on: () => {}, hap: {
    CameraController: class { constructor(options: any) {delegate = options.delegate;} forceStopStreamingSession() {} },
    SRTPCryptoSuites: {AES_CM_128_HMAC_SHA1_80: 0}, H264Profile: {BASELINE: 0}, H264Level: {LEVEL3_1: 0, LEVEL3_2: 1},
  }};
  const platform = new StateGridPlatform(log as any, {} as any, api as any) as any;
  const entry = {camera: {snapshot: vi.fn().mockResolvedValue(Buffer.from('frame')), prepareStream: vi.fn().mockResolvedValue({port: 10001, ssrc: 1, srtpKey: Buffer.alloc(16), srtpSalt: Buffer.alloc(14)}), startStream: vi.fn().mockResolvedValue(undefined), stopStream: vi.fn(), reconfigure: vi.fn()}, cameraError: undefined};
  platform.attachCameraController({configureController: () => {}}, entry);
  try {await test(delegate, entry);} finally {platform.stop(); rmSync(dir, {recursive: true, force: true});}
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const prepare = {sessionID: 'one', targetAddress: '127.0.0.1', video: {port: 10002, srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14)}};
const ended = () => {throw new Error('This callback function has already been called by someone else');};

describe('HomeKit 请求结束后的回调安全', () => {
  it('协商响应被 HAP 拒绝时只回调一次，释放会话，不崩溃', async () => withDelegate(async (delegate, entry) => {
    const callback = vi.fn(ended); delegate.prepareStream(prepare, callback); await flush();
    expect(callback).toHaveBeenCalledOnce(); expect(entry.camera.stopStream).toHaveBeenCalledWith('one');
  }));
  it('快照回调已超时时不重复回调', async () => withDelegate(async (delegate) => {
    const callback = vi.fn(ended); delegate.handleSnapshotRequest({}, callback); await flush();
    expect(callback).toHaveBeenCalledOnce();
  }));
  it('视频开始响应抛错时不二次回调，清理该会话', async () => withDelegate(async (delegate, entry) => {
    delegate.prepareStream(prepare, () => {}); await flush();
    const callback = vi.fn(ended); delegate.handleStreamRequest({sessionID: 'one', type: 'start'}, callback); await flush();
    expect(callback).toHaveBeenCalledOnce(); expect(entry.camera.stopStream).toHaveBeenCalledWith('one');
  }));
  it('STOP 先于协商完成时丢弃迟到结果', async () => withDelegate(async (delegate, entry) => {
    let finish!: Function; entry.camera.prepareStream.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    const callback = vi.fn(); delegate.prepareStream(prepare, callback);
    delegate.handleStreamRequest({sessionID: 'one', type: 'stop'}, () => {});
    finish({port: 10001, ssrc: 1}); await flush();
    expect(callback).not.toHaveBeenCalled(); expect(entry.camera.stopStream).toHaveBeenCalledWith('one');
  }));
});
