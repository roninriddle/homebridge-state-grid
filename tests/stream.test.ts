import { describe, it, expect } from 'vitest';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageCamera } from '../src/camera/camera-accessory.js';
import { deriveSessionKeys, unprotectRtp } from '../src/camera/srtp.js';
import { renderPng, fallbackCardSvg, defaultFfmpegPath } from '../src/renderer/image-renderer.js';

// 显式运行 npm run test:stream：只绑定回环地址，不连接国网或 Homebridge。
describe.runIf(process.env.SGCC_STREAM_TEST === '1')('独立 ffmpeg SRTP 互通', () => {
  it('双会话可解密、协商参数生效、实际发送限速，并能由 ffmpeg 解码', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sgcc-stream-'));
    const receiver = createSocket('udp4');
    await new Promise<void>((resolve) => receiver.bind(0, '127.0.0.1', resolve));
    const port = (receiver.address() as {port: number}).port;
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const salt = Buffer.from('00112233445566778899aabbccdd', 'hex');
    const keys = deriveSessionKeys({masterKey: key, masterSalt: salt});
    const timestamps = new Set<number>();
    let firstPacket: Buffer | undefined;
    let packetError: Error | undefined;
    receiver.on('message', (packet) => {
      if ((packet[1] & 127) !== 110) return;
      try {
        const opened = unprotectRtp(packet, keys, 12, packet.readUInt32BE(8), packet.readUInt16BE(2));
        expect(opened.payload.length).toBeGreaterThan(0);
        expect(packet.length).toBeLessThanOrEqual(800);
        timestamps.add(packet.readUInt32BE(4)); firstPacket ??= packet;
      } catch (error) { packetError = error as Error; }
    });
    const png = renderPng(fallbackCardSvg(640, 360, '独立视频测试'));
    const log = {warn: () => {}, error: () => {}, debug: () => {}};
    const camera = new UsageCamera({name: 'test', log: log as any, width: 1280, height: 720, snapshot: async () => Buffer.alloc(0), frame: async () => png,
      writeFrame: async (frame) => {const file = join(dir, 'frame.png'); writeFileSync(file, frame); return file;}, ffmpegPath: defaultFfmpegPath()});
    let decoder: ReturnType<typeof spawn> | undefined;
    try {
      const request = {sessionID: 'one', address: '127.0.0.1', videoPort: port, videoSrtpKey: key, videoSrtpSalt: salt, payloadType: 110, width: 640, height: 360, fps: 2, bitrate: 160, mtu: 800};
      await camera.prepareStream(request); await camera.startStream(request);
      const reserve = createSocket('udp4'); await new Promise<void>((resolve) => reserve.bind(0, '127.0.0.1', resolve));
      const secondPort = (reserve.address() as {port: number}).port; await new Promise<void>((resolve) => reserve.close(resolve));
      const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=State Grid', 'c=IN IP4 127.0.0.1', 't=0 0', 'm=video ' + secondPort + ' RTP/SAVP 110', 'a=rtpmap:110 H264/90000', 'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + Buffer.concat([key,salt]).toString('base64'), ''].join('\n');
      const sdpFile = join(dir, 'receive.sdp'); writeFileSync(sdpFile, sdp);
      decoder = spawn(defaultFfmpegPath(), ['-hide_banner','-loglevel','error','-protocol_whitelist','file,udp,rtp,crypto','-i',sdpFile,'-frames:v','1','-f','image2pipe','-c:v','png','pipe:1'], {stdio:['ignore','pipe','pipe']});
      let stderr = ''; decoder.stderr?.on('data',(x)=>{stderr += x.toString();});
      const decoded = new Promise<Buffer>((resolve,reject)=>{
        const chunks: Buffer[]=[]; const timer=setTimeout(()=>reject(new Error('独立解码超时：'+stderr)),12000);
        decoder!.stdout?.on('data',(x: Buffer)=>{chunks.push(x); const bytes=Buffer.concat(chunks); if(bytes.length>8 && bytes.includes(Buffer.from('IEND'))) {clearTimeout(timer);resolve(bytes);}});
        decoder!.once('error',(error)=>{clearTimeout(timer);reject(error);});
        decoder!.once('exit',(code)=>{clearTimeout(timer);if(!chunks.length)reject(new Error('解码失败 '+code+': '+stderr));});
      });
      const second = {...request,sessionID:'two',videoPort:secondPort};
      const plan2 = await camera.prepareStream(second); await camera.startStream(second);
      const image = await decoded;
      expect(image.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a'); expect(image.readUInt32BE(16)).toBe(640); expect(image.readUInt32BE(20)).toBe(360);
      const before = timestamps.size; camera.stopStream('two'); await new Promise((resolve)=>setTimeout(resolve,1100));
      expect(timestamps.size).toBeGreaterThan(before); expect(timestamps.size).toBeLessThan(30); expect(packetError).toBeUndefined(); expect(firstPacket).toBeDefined();
      expect(firstPacket!.readUInt32BE(8)).not.toBe(plan2.ssrc);
    } finally {camera.stopStream(); decoder?.kill('SIGKILL'); receiver.close(); rmSync(dir,{recursive:true,force:true});}
  }, 20000);
});
