/**
 * SVG → 位图栅格化。
 *
 * 两个决定：
 *
 * 1. 用 resvg 而不是 node-canvas。后者依赖 cairo/pango，macOS 上要 brew、
 *    Docker 里要装一堆 apt 包，是这类插件"装不上"的头号原因。resvg 提供
 *    预编译二进制，零系统依赖。
 *
 * 2. PNG → JPEG 交给 ffmpeg，而不是引入 jpeg-js/pngjs。ffmpeg 本来就是硬
 *    依赖（视频流要用，`ffmpeg-for-homebridge` 自带静态二进制），再做一次
 *    图片转码不增加任何安装面；而纯 JS 编码那条路要把 PNG 全解成 RGBA 再
 *    重新编码一遍，对这种"大字 + 纯色块"的卡片没有任何画质收益。
 *
 * 所以：视频流的输入帧用 PNG（ffmpeg 直接吃），HomeKit 快照才转成 JPEG。
 */

import { spawn } from 'node:child_process';

import { Resvg } from '@resvg/resvg-js';
import ffmpegStatic from 'ffmpeg-for-homebridge';

import { escapeXml } from './format.js';

export interface RenderOptions {
  width?: number;
  quality?: number;
  /** 中文渲染依赖系统字体，可在配置里覆盖。 */
  fontFamily?: string;
  /** 覆盖 ffmpeg 路径（测试或特殊部署时用）。 */
  ffmpegPath?: string;
}

/** 默认 ffmpeg：优先用随包附带的静态二进制。 */
export function defaultFfmpegPath(): string {
  return (ffmpegStatic as unknown as string) || 'ffmpeg';
}

/** SVG → PNG。同步，resvg 本身就是同步的，没必要包一层 Promise。 */
export function renderPng(svg: string, options: RenderOptions = {}): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: options.width ? { mode: 'width', value: options.width } : { mode: 'original' },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: options.fontFamily ?? 'PingFang SC',
    },
    background: '#FFFFFF',
  });
  return Buffer.from(resvg.render().asPng());
}

/** quality(0-100) 映射到 mjpeg 的 qscale(2-31，越小越好)。 */
function qscaleFor(quality: number): number {
  if (quality >= 92) return 2;
  if (quality >= 84) return 3;
  if (quality >= 74) return 5;
  if (quality >= 60) return 8;
  return 12;
}

const TRANSCODE_TIMEOUT_MS = 10_000;

/**
 * PNG → JPEG，走管道，不落临时文件。
 *
 * 单张 1280×720 大约几十毫秒，而快照只在有人打开摄像头时才被请求，且渲染
 * 结果会缓存到下一次数据刷新，所以这点开销可以忽略。
 */
export function pngToJpeg(png: Buffer, options: RenderOptions = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpegPath = options.ffmpegPath ?? defaultFfmpegPath();
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-c:v', 'png',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', String(qscaleFor(options.quality ?? 88)),
      '-pix_fmt', 'yuvj420p',
      'pipe:1',
    ];

    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('PNG 转 JPEG 超时'));
    }, TRANSCODE_TIMEOUT_MS);
    timer.unref?.();

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.on('error', (error) => fail(new Error(`无法启动 ffmpeg：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      if (code !== 0 || output.length === 0) {
        reject(new Error(`ffmpeg 转码失败（code=${code}）：${stderr.trim().slice(0, 300)}`));
        return;
      }
      resolve(output);
    });

    // ffmpeg 提前退出时 stdin 会 EPIPE，这里吞掉即可，真正的错误由 close 报告。
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(png);
  });
}

/** SVG → JPEG，快照走这一个。 */
export async function renderJpeg(svg: string, options: RenderOptions = {}): Promise<Buffer> {
  return pngToJpeg(renderPng(svg, options), options);
}

/** 渲染失败时的兜底图：绝不能返回空 buffer，否则家庭 App 会显示灰块。 */
export function fallbackCardSvg(width: number, height: number, message: string): string {
  const fontSize = Math.round(Math.min(width, height) * 0.06);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#F2F2F7"/>
<circle cx="${width / 2}" cy="${height / 2 - fontSize * 1.2}" r="${fontSize * 0.32}" fill="#C7C7CC"/>
<text x="${width / 2}" y="${height / 2 + fontSize * 0.4}" font-family="'PingFang SC', system-ui, sans-serif" font-size="${fontSize}" fill="#8E8E93" text-anchor="middle">${escapeXml(message)}</text>
</svg>`;
}
