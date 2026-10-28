/**
 * H.264 Annex-B 流解析与 RTP 打包。
 *
 * ffmpeg 输出的是 Annex-B 字节流（SPS/PPS/IDR/P 帧之间用起始码分隔），而 HomeKit
 * 要的是 RTP 包，所以中间需要按 NAL 切分，超 MTU 的 NAL 用 FU-A 分片。
 */

export const MAX_PAYLOAD = 1400;

/** 从字节流中切出完整 NAL，返回剩余未完成部分。 */
export function splitNalUnits(buffer: Buffer): { nals: Buffer[]; rest: Buffer } {
  const starts: Array<{ offset: number; length: number }> = [];
  for (let i = 0; i + 3 <= buffer.length; i++) {
    if (buffer[i] === 0 && buffer[i + 1] === 0) {
      if (buffer[i + 2] === 1) {
        starts.push({ offset: i, length: 3 });
        i += 2;
      } else if (i + 4 <= buffer.length && buffer[i + 2] === 0 && buffer[i + 3] === 1) {
        starts.push({ offset: i, length: 4 });
        i += 3;
      }
    }
  }
  if (starts.length < 2) {
    // 还不构成一个完整 NAL，整段留到下一批。
    return { nals: [], rest: buffer };
  }
  const nals: Buffer[] = [];
  for (let index = 0; index < starts.length - 1; index++) {
    const begin = starts[index].offset + starts[index].length;
    const end = starts[index + 1].offset;
    if (end > begin) nals.push(buffer.subarray(begin, end));
  }
  // 最后一个起始码之后的内容可能不完整，连同起始码一起留给下一批。
  const last = starts[starts.length - 1];
  return { nals, rest: buffer.subarray(last.offset) };
}

export function nalType(nal: Buffer): number {
  return nal.length ? nal[0] & 0x1f : 0;
}

export interface RtpHeaderOptions {
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  marker: boolean;
}

export function buildRtpHeader(options: RtpHeaderOptions): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (options.marker ? 0x80 : 0) | (options.payloadType & 0x7f);
  header.writeUInt16BE(options.sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(options.timestamp >>> 0, 4);
  header.writeUInt32BE(options.ssrc >>> 0, 8);
  return header;
}

export interface PacketsResult {
  packets: Array<{ header: Buffer; payload: Buffer; marker: boolean }>;
  nextSequence: number;
}

/**
 * 把一个 NAL 打成 1..n 个 RTP 包。
 *
 * 只有一帧的最后一个包才置 marker 位——HomeKit 靠它判断帧边界，
 * 每条分片都置位会让解码器提前收帧。
 */
export function packetizeNal(
  nal: Buffer,
  options: { payloadType: number; sequenceNumber: number; timestamp: number; ssrc: number },
): PacketsResult {
  const packets: PacketsResult['packets'] = [];
  let sequence = options.sequenceNumber;

  if (nal.length <= MAX_PAYLOAD) {
    packets.push({
      header: buildRtpHeader({
        payloadType: options.payloadType,
        sequenceNumber: sequence++,
        timestamp: options.timestamp,
        ssrc: options.ssrc,
        marker: true,
      }),
      payload: nal,
      marker: true,
    });
    return { packets, nextSequence: sequence };
  }

  const indicator = (nal[0] & 0xe0) | 28; // FU-A
  const nalHeader = nal[0] & 0x1f;
  const data = nal.subarray(1);
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + MAX_PAYLOAD);
    offset += chunk.length;
    const isFirst = offset === chunk.length;
    const isLast = offset >= data.length;
    const fuHeader =
      (isFirst ? 0x80 : 0) | (isLast ? 0x40 : 0) | nalHeader;
    const payload = Buffer.concat([Buffer.from([indicator, fuHeader]), chunk]);
    packets.push({
      header: buildRtpHeader({
        payloadType: options.payloadType,
        sequenceNumber: sequence++,
        timestamp: options.timestamp,
        ssrc: options.ssrc,
        marker: isLast,
      }),
      payload,
      marker: isLast,
    });
  }
  return { packets, nextSequence: sequence };
}

/** 从 SPS 里推导 HomeKit SDP 需要的分辨率字段（宽松解析，失败返回默认）。 */
export function spsToBase64(sps: Buffer): string {
  return sps.toString('base64');
}
