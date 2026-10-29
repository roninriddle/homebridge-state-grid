/** HomeKit 协商与独立会话；H.264、SRTP 和 RTCP 交给 ffmpeg。 */
import { createSocket, type Socket } from 'node:dgram';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Logger } from 'homebridge';

export interface CameraStreamRequest {
  sessionID?: string;
  address: string;
  videoPort: number;
  videoSrtpKey: Buffer;
  videoSrtpSalt: Buffer;
  payloadType?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  mtu?: number;
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

export function streamArguments(request: CameraStreamRequest, plan: StreamPlan, imagePath: string, width: number, height: number): string[] {
  const host = isIP(request.address) === 6 ? '[' + request.address + ']' : request.address;
  const fps = Math.max(1, Math.min(FRAME_RATE, request.fps ?? FRAME_RATE));
  const bitrate = Math.max(64, Math.min(2000, request.bitrate ?? 300));
  const key = Buffer.concat([plan.srtpKey, plan.srtpSalt]).toString('base64');
  return [
    '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats',
    '-re', '-loop', '1', '-framerate', String(fps), '-i', imagePath,
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.1',
    '-s', String(request.width ?? width) + 'x' + String(request.height ?? height),
    '-r', String(fps), '-g', String(Math.max(1, Math.round(fps))),
    '-b:v', bitrate + 'k', '-maxrate', bitrate + 'k', '-bufsize', (bitrate * 2) + 'k',
    '-payload_type', String(request.payloadType ?? PAYLOAD_TYPE),
    '-ssrc', String(plan.ssrc), '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', key,
    'srtp://' + host + ':' + request.videoPort + '?rtcpport=' + request.videoPort + '&pkt_size=' + Math.max(256, Math.min(1316, request.mtu ?? 1316)),
  ];
}
interface Session {
  request: CameraStreamRequest;
  plan: StreamPlan;
  socket: Socket;
  timer?: NodeJS.Timeout;
  ffmpeg?: ChildProcess;
  stopping?: boolean;
  active?: boolean;
}
export interface CameraAccessoryOptions {
  name: string;
  snapshot: () => Promise<Buffer>;
  frame: () => Promise<Buffer>;
  writeFrame: (frame: Buffer) => Promise<string>;
  ffmpegPath: string;
  width: number;
  height: number;
  log: Logger;
  onStreamError?: (sessionID: string) => void;
}
export class UsageCamera {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly options: CameraAccessoryOptions) {}
  snapshot(): Promise<Buffer> { return this.options.snapshot(); }

  async prepareStream(request: CameraStreamRequest): Promise<StreamPlan> {
    const id = request.sessionID ?? 'legacy';
    this.stopStream(id);
    if (!isIP(request.address) || request.videoPort < 1 || request.videoPort > 65535 ||
        request.videoSrtpKey.length !== 16 || request.videoSrtpSalt.length !== 14) throw new Error('无效的摄像头协商参数');
    const socket = createSocket(isIP(request.address) === 6 ? 'udp6' : 'udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => { socket.removeListener('error', reject); resolve(); });
    }).catch((error) => { socket.close(); throw error; });
    const plan: StreamPlan = {
      port: (socket.address() as {port: number}).port,
      ssrc: randomBytes(4).readUInt32BE(0) & 0x7fffffff,
      srtpKey: request.videoSrtpKey,
      srtpSalt: request.videoSrtpSalt,
    };
    const session: Session = { request, plan, socket };
    socket.on('error', () => this.failSession(id, '视频 UDP 连接异常'));
    session.timer = setTimeout(() => this.stopStream(id), 30_000);
    session.timer.unref?.();
    this.sessions.set(id, session);
    return plan;
  }

  async startStream(request: CameraStreamRequest): Promise<void> {
    const id = request.sessionID ?? 'legacy';
    const session = this.sessions.get(id);
    if (!session) throw new Error('流未协商');
    if (session.active) throw new Error('视频会话已经启动');
    session.active = true;
    clearTimeout(session.timer);
    const merged = { ...session.request, ...request };
    try {
      const frame = await this.options.frame();
      const imagePath = await this.options.writeFrame(frame);
      if (session.stopping) throw new Error('视频会话已停止');
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        const timer = setTimeout(() => {
          reject(new Error('视频编码器启动超时'));
          this.stopStream(id);
        }, 8000);
        timer.unref?.();
        const ff = spawn(this.options.ffmpegPath, streamArguments(merged, session.plan, imagePath, this.options.width, this.options.height), { stdio: ['ignore', 'ignore', 'pipe'] });
        session.ffmpeg = ff;
        ff.stderr?.on('data', (chunk: Buffer) => {
          if (/frame=\s*[1-9]/.test(chunk.toString())) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
        });
        ff.once('error', () => { clearTimeout(timer); reject(new Error('无法启动视频编码器')); this.failSession(id, '无法启动视频编码器'); });
        ff.once('exit', () => {
          clearTimeout(timer);
          if (!ready) reject(new Error('视频编码器未能输出画面'));
          if (!session.stopping) this.failSession(id, '视频编码器已退出');
        });
      });
    } catch (error) {
      this.stopStream(id);
      throw error;
    }
  }

  async reconfigure(sessionID: string, options: Partial<CameraStreamRequest>): Promise<void> {
    const previous = this.sessions.get(sessionID);
    if (!previous) throw new Error('找不到视频会话');
    const request = { ...previous.request, ...options, sessionID };
    await this.prepareStream(request);
    await this.startStream(request);
  }

  private failSession(id: string, message: string): void {
    const session = this.sessions.get(id);
    if (!session || session.stopping) return;
    this.options.log.warn(message);
    this.stopStream(id);
    this.options.onStreamError?.(id);
  }

  stopStream(sessionID?: string): void {
    for (const [id, session] of this.sessions) {
      if (sessionID !== undefined && sessionID !== id) continue;
      session.stopping = true;
      clearTimeout(session.timer);
      session.ffmpeg?.kill('SIGKILL');
      try { session.socket.close(); } catch { /* 已关闭 */ }
      this.sessions.delete(id);
    }
  }
}
export const CAMERA_CONSTANTS = { FRAME_RATE, PAYLOAD_TYPE, CLOCK_RATE };
