/**
 * HomeKit 虚拟摄像头：把渲染好的用电卡片当作"摄像头画面"。
 *
 * 两件事必须同时成立，否则家庭 App 里体验会崩：
 *  1. 快照（handleSnapshotRequest）——首页缩略图用，必须永远返回一张 JPEG；
 *  2. 视频流（prepareStream/handleStreamRequest）——点开后不能黑屏，
 *     这里用 ffmpeg 把最新快照循环编码成低帧率 H.264 再打 SRTP 发出去。
 *
 * 只在有人真的点开时才启动 ffmpeg，断开立刻结束，避免长期占用 CPU。
 */

import { createSocket, type Socket } from 'node:dgram';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from 'homebridge';

import { deriveSessionKeys, protectRtp, type SessionKeys } from './srtp.js';
import { nalType, packetizeNal, splitNalUnits } from './rtp.js';

export interface CameraStreamRequest {
  address: string;
  videoPort: number;
  videoSrtpKey: Buffer;
  videoSrtpSalt: Buffer;
}

export interface StreamPlan {
  port: number;
  ssrc: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
}

const FRAME_RATE = 2;
const PAYLOAD_TYPE = 99;
const CLOCK_RATE = 90_000;

class StreamSession {
  private socket: Socket | null = null;
  private ffmpeg: ChildProcess | null = null;
  private sequence = 1;
  private timestamp = 0;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private stopped = false;

  constructor(
    private readonly request: CameraStreamRequest,
    private readonly localPort: number,
    private readonly ssrc: number,
    private readonly keys: SessionKeys,
    private readonly logger: Logger,
  ) {}

  start(imagePath: string, ffmpegPath: string, width: number, height: number): void {
    const socket = createSocket('udp4');
    socket.bind(this.localPort);
    this.socket = socket;

    const args = [
      '-loop', '1',
      '-framerate', String(FRAME_RATE),
      '-i', imagePath,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-s', `${width}x${height}`,
      '-r', String(FRAME_RATE),
      '-g', String(FRAME_RATE),
      '-x264-params', `repeat-headers=1:keyint=${FRAME_RATE}`,
      '-f', 'h264',
      '-',
    ];

    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ff;

    ff.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    ff.stderr?.on('data', (chunk: Buffer) => {
      this.logger.debug?.(`[ffmpeg] ${chunk.toString().slice(0, 200)}`);
    });
    ff.on('error', (error) => {
      this.logger.error(`摄像头流启动失败：${error.message}`);
      this.stop();
    });
    ff.on('exit', () => {
      this.stop();
    });
  }

  private onData(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { nals, rest } = splitNalUnits(this.buffer);
    this.buffer = rest;

    for (const nal of nals) {
      const type = nalType(nal);
      if (type === 7) {
        this.sps = nal;
        continue;
      }
      if (type === 8) {
        this.pps = nal;
        continue;
      }
      if (type === 5) {
        // IDR 前重发参数集，保证中途加入的 HomeKit 客户端也能解码。
        if (this.sps) this.sendNal(this.sps, this.timestamp, false);
        if (this.pps) this.sendNal(this.pps, this.timestamp, false);
      }
      if (type === 1 || type === 5) {
        this.sendNal(nal, this.timestamp, true);
        this.timestamp = (this.timestamp + CLOCK_RATE / FRAME_RATE) >>> 0;
      } else {
        this.sendNal(nal, this.timestamp, false);
      }
    }
  }

  private sendNal(nal: Buffer, timestamp: number, endOfFrame: boolean): void {
    if (!this.socket || this.stopped) return;
    const { packets, nextSequence } = packetizeNal(nal, {
      payloadType: PAYLOAD_TYPE,
      sequenceNumber: this.sequence,
      timestamp,
      ssrc: this.ssrc,
    });
    this.sequence = nextSequence;
    packets.forEach((packet, index) => {
      const isLast = index === packets.length - 1;
      const protectedPacket = protectRtp(
        { header: packet.header, payload: packet.payload },
        this.keys,
        this.ssrc,
        this.sequence - packets.length + index,
      );
      // marker 位已经在头部里了；这里只负责把最后一包标出去以便日志排查。
      this.socket?.send(
        protectedPacket,
        this.request.videoPort,
        this.request.address,
        (error) => {
          if (error && isLast && endOfFrame) {
            this.logger.debug?.(`发送视频包失败：${error.message}`);
          }
        },
      );
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ffmpeg?.kill('SIGKILL');
    this.ffmpeg = null;
    try {
      this.socket?.close();
    } catch {
      /* socket 可能已经关闭 */
    }
    this.socket = null;
  }
}

export interface CameraAccessoryOptions {
  name: string;
  /** HomeKit 快照（JPEG），每次请求都现取，保证内容是最新的。 */
  snapshot: () => Promise<Buffer>;
  /** ffmpeg 循环编码的输入帧（PNG），质量要求低，但必须与快照同源。 */
  frame: () => Promise<Buffer>;
  /** 把输入帧写到磁盘，返回路径供 ffmpeg 读取。 */
  writeFrame: (frame: Buffer) => Promise<string>;
  ffmpegPath: string;
  width: number;
  height: number;
  log: Logger;
}

/** 挂到 Accessory 上的摄像头控制器封装。 */
export class UsageCamera {
  private stream: StreamSession | null = null;
  private plan: StreamPlan | null = null;

  constructor(private readonly options: CameraAccessoryOptions) {}

  /** 供 hap 的 CameraController 调用。 */
  async snapshot(): Promise<Buffer> {
    try {
      return await this.options.snapshot();
    } catch (error) {
      this.options.log.warn(
        `快照渲染失败，返回占位图：${(error as Error).message}`,
      );
      throw error;
    }
  }

  prepareStream(request: CameraStreamRequest): StreamPlan {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const ssrc = Math.floor(Math.random() * 0xffffffff);
    this.plan = {
      port,
      ssrc,
      srtpKey: request.videoSrtpKey,
      srtpSalt: request.videoSrtpSalt,
    };
    return this.plan;
  }

  async startStream(request: CameraStreamRequest): Promise<void> {
    if (!this.plan) throw new Error('流未协商');
    const plan = this.plan;
    this.stopStream();
    const keys = deriveSessionKeys({
      masterKey: plan.srtpKey,
      masterSalt: plan.srtpSalt,
    });
    const session = new StreamSession(
      request,
      plan.port,
      plan.ssrc,
      keys,
      this.options.log,
    );
    this.stream = session;

    // 视频流用 PNG 帧即可：ffmpeg 反正要重新编码成 H.264，多转一次 JPEG 只是浪费。
    const frame = await this.options.frame();
    const imagePath = await this.options.writeFrame(frame);
    session.start(imagePath, this.options.ffmpegPath, this.options.width, this.options.height);
  }

  stopStream(): void {
    this.stream?.stop();
    this.stream = null;
  }
}

export const CAMERA_CONSTANTS = {
  FRAME_RATE,
  PAYLOAD_TYPE,
  CLOCK_RATE,
};
