/**
 * 稳定的合成 Android 设备特征档案。
 *
 * 该档案由一枚 32 字节随机种子锚定，用 HMAC-SHA256 派生全部"设备标识"，
 * 因此同一台 Homebridge 每次启动都会生成完全相同的特征组合——这是服务端
 * 不把插件当成新设备的前提。
 *
 * 移植自上游 `turing/feature_profile.py`，字段数量（native 62 个 / Java 52 个）
 * 与键顺序都参与协议形态，不能随意增减。
 */

import { createHmac, randomBytes } from 'node:crypto';
import referenceEnvironment from './data/reference_environment.json';

export const SCHEMA_VERSION = 1;
export const CHANNEL = '10000191';
export const PACKAGE_NAME = 'com.sgcc.wsgw.cn';
export const BUILD_MARKER = '77F2B17A00A92C71';

const REFERENCE_NATIVE_FEATURES = new Map<number, string>(
  Object.entries(referenceEnvironment.stable_feature_values as Record<string, string>).map(
    ([key, value]) => [Number(key), value],
  ),
);

const JAVA_SDK_CONSTANTS = new Map<number, string>(
  Object.entries(referenceEnvironment.java_sdk_constants as Record<string, string>).map(
    ([key, value]) => [Number(key), value],
  ),
);

const DEVICE_CATALOG = [
  {
    brand: 'google',
    manufacturer: 'Google',
    model: 'sdk_gphone64_arm64',
    device: 'emu64a',
    product: 'sdk_gphone64_arm64',
    board: 'goldfish_arm64',
    hardware: 'ranchu',
  },
] as const;

/** 官方 App 中 52 键 Java Map 的原始顺序。 */
export const OFFICIAL_JAVA_KEYS: ReadonlyArray<number | string> = [
  1, 4, 205, 210, 240, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 264, 266, 267,
  268, 269, 270, 271, 272, 273, 279, 280, 281, 282, 284, 285, 286, 287, 288, 303, 308,
  309, 402, 406, 2001, 2005, 2013, 2016, 2017, 2018, 2019, 2021, 2029, 3001, 3002, 3004,
  3005, 'com.google.android.providers.gsf.permission.READ_GSERVICES',
];

const JAVA_PERFORMANCE_ORDER: ReadonlyArray<number | string> = [
  133, 138, 140, -17, 17, 145, 146, 149, 22, 150, 151, 24, 100, 101, 102, 103, 104, 105,
  106, 107, 44, 113, 114, 115, 116, 117, 118, 120, 122, 's9',
];

const JAVA_PERFORMANCE_REFERENCE: Record<string | number, number> = {
  133: 0, 138: 1, 140: 0, '-17': 0, 17: 1, 145: 0, 146: 0, 149: 0, 22: 1, 150: 0, 151: 0,
  24: 0, 100: 6, 101: 114, 102: 0, 103: 0, 104: 0, 105: 0, 106: 3, 107: 0, 44: 0, 113: 2,
  114: 1, 115: 1, 116: 0, 117: 0, 118: 0, 120: 8, 122: 0, s9: 1,
};

const NATIVE_PERFORMANCE_ORDER: readonly number[] = [
  21, 7, 10, 14, 33, 11, 24, 12, 23, 8, 13, 25, 20, 35, 42, 121, 135, 124, 125, 129, 131,
  134, 132, 137, 142, 141, 9, 15, 16,
];

const NATIVE_PERFORMANCE_REFERENCE: Record<number, number> = {
  21: 1, 7: 0, 10: 3, 14: 0, 33: 0, 11: 0, 24: 0, 12: 0, 23: 0, 8: 0, 13: 0, 25: 0, 20: 0,
  35: 0, 42: 0, 121: 1, 135: 2, 124: 0, 125: 0, 129: 0, 131: 0, 134: 0, 132: 0, 137: 1,
  142: 0, 141: 0, 9: 16, 15: 0, 16: 0,
};

/** sign, kind, owner( null 表示 App UID ), 三个固定字段, 指标位数。 */
const PROCESS_ENTRY_TEMPLATES: ReadonlyArray<
  readonly [number, number, number | null, number, number, number, number]
> = [
  [-1, 3, 1000, 17, 0, 438, 3],
  [-1, 1, 0, 20, 0, 493, 3],
  [1, 1, 1000, 1864, 1036632, 420, 2],
  [-1, 1, 0, 20, 0, 493, 2],
  [1, 3, 1000, 17, 0, 438, 3],
  [1, 1, null, 19, 0, 292, 6],
  [-1, 1, null, 19, 0, 292, 6],
];

export interface AndroidIdentity {
  profileId: string;
  androidId: string;
  oaid: string;
  wifiMac: string;
  serial: string;
  buildId: string;
  incremental: string;
  release: string;
  sdkInt: number;
  brand: string;
  manufacturer: string;
  model: string;
  device: string;
  product: string;
  board: string;
  hardware: string;
  packageName: string;
  channel: string;
}

const PROFILE_SALT = Buffer.from('wsgw-turing-profile-v1\0', 'utf8');

/** Java 的 URL_SAFE Base64 保留 `=` 填充，Node 的 base64url 会去掉。 */
function urlsafeBase64(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export interface ProfileSeedOptions {
  bootEpochMs?: number;
  installEpochMs?: number;
}

export class StableProfile {
  private readonly seed: Buffer;
  private readonly bootEpochMs?: number;
  private readonly installEpochMs?: number;

  constructor(seed: Buffer, options: ProfileSeedOptions = {}) {
    if (seed.length !== 32) throw new Error('Turing profile seed must be 32 bytes');
    this.seed = seed;
    this.bootEpochMs = options.bootEpochMs;
    this.installEpochMs = options.installEpochMs;
  }

  /** 用种子派生确定性字节流。 */
  bytes(label: string, size = 32): Buffer {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be positive');
    const chunks: Buffer[] = [];
    let produced = 0;
    let counter = 0;
    while (produced < size) {
      const counterBytes = Buffer.allocUnsafe(4);
      counterBytes.writeUInt32BE(counter, 0);
      const digest = createHmac('sha256', this.seed)
        .update(PROFILE_SALT)
        .update(Buffer.from(label, 'utf8'))
        .update(counterBytes)
        .digest();
      chunks.push(digest);
      produced += digest.length;
      counter++;
    }
    return Buffer.concat(chunks).subarray(0, size);
  }

  hex(label: string, size = 16): string {
    return this.bytes(label, size).toString('hex');
  }

  /**
   * 用种子取 [lower, upper] 内的确定性整数。
   *
   * 必须全程用 BigInt：`process-hash` 的取值范围接近 9e18，远超
   * Number.MAX_SAFE_INTEGER，先转 Number 再取模会丢掉低位。
   */
  integerBig(label: string, lower: number, upper: number): bigint {
    if (lower > upper) throw new RangeError('invalid integer range');
    const value = this.bytes(label, 8).readBigUInt64BE(0);
    // 区间宽度也必须是 BigInt：9e18-1e18+1 超出 double 精度，
    // 用 Number 算会悄悄少 1。
    const lo = BigInt(lower);
    const hi = BigInt(upper);
    return lo + (value % (hi - lo + 1n));
  }

  integer(label: string, lower: number, upper: number): number {
    return Number(this.integerBig(label, lower, upper));
  }

  requestInteger(label: string, timestampMs: number, lower: number, upper: number): number {
    return this.integer(`request:${timestampMs}:${label}`, lower, upper);
  }

  uuid(label: string): string {
    const value = this.bytes(label, 16);
    value[6] = (value[6] & 0x0f) | 0x40;
    value[8] = (value[8] & 0x3f) | 0x80;
    const hex = value.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  identity(): AndroidIdentity {
    const device = DEVICE_CATALOG[this.integer('device-catalog', 0, DEVICE_CATALOG.length - 1)];
    const mac = Buffer.from(this.bytes('wifi-mac', 6));
    mac[0] = (mac[0] & 0xfe) | 0x02;
    return {
      profileId: this.uuid('profile-id'),
      androidId: this.hex('android-id', 8),
      oaid: this.uuid('oaid'),
      wifiMac: [...mac].map((part) => part.toString(16).padStart(2, '0')).join(':'),
      serial: `TUR${this.hex('serial', 7).toUpperCase()}`,
      buildId: 'TE1A.240213.009',
      incremental: '12342917',
      release: '13',
      sdkInt: 33,
      ...device,
      packageName: PACKAGE_NAME,
      channel: CHANNEL,
    };
  }

  private timingValue(label: string, timestampMs: number, reference: number): number {
    if (reference <= 0) return 0;
    const radius = Math.max(1, Math.floor(reference / 4));
    const digits = String(reference).length;
    const sameWidthLower = digits > 1 ? 10 ** (digits - 1) : 0;
    const sameWidthUpper = 10 ** digits - 1;
    return this.requestInteger(
      `timing:${label}`,
      timestampMs,
      Math.max(sameWidthLower, reference - radius),
      Math.min(sameWidthUpper, reference + radius),
    );
  }

  javaPerformanceContext(timestampMs: number): string {
    return JAVA_PERFORMANCE_ORDER.map((feature) => {
      const elapsed = this.timingValue(
        String(feature),
        timestampMs,
        JAVA_PERFORMANCE_REFERENCE[feature as number] ?? 0,
      );
      return `${feature}_${elapsed}`;
    }).join(',');
  }

  directPerformanceContext(timestampMs: number): string {
    const suffix = NATIVE_PERFORMANCE_ORDER.map((feature) => {
      const elapsed = this.timingValue(
        `native-${feature}`,
        timestampMs,
        NATIVE_PERFORMANCE_REFERENCE[feature],
      );
      return `${feature}_${elapsed}`;
    }).join(',');
    return `${this.javaPerformanceContext(timestampMs)},${suffix}`;
  }

  /** 完整的 62 标签 native 特征映射。 */
  nativeFeatureMap(nowMs?: number): Map<number, string> {
    const identity = this.identity();
    const current = nowMs === undefined ? Date.now() : Math.trunc(nowMs);

    const bootEpochMs =
      this.bootEpochMs ?? current - this.integer('boot-age-ms', 3_600_000, 86_400_000 * 14);
    const uid = this.integer('uid', 10_000, 19_999);
    const installEpochMs =
      this.installEpochMs ??
      bootEpochMs - this.integer('install-age-ms', 86_400_000, 86_400_000 * 180);

    // 注意：Node 的 base64url 不带 padding，而 Java 的
    // Base64.encodeToString(..., URL_SAFE) 保留 padding。install_a 必须补回
    // "=="，否则 tag 17 的字符串长度会差 2 字节，服务端会判定特征异常。
    const installA = urlsafeBase64(Buffer.from(this.bytes('install-a', 16)));
    const installB = urlsafeBase64(Buffer.from(this.bytes('install-b', 16))).replace(/=+$/, '') + '=';

    const installContext =
      `1:1:${uid}:${installEpochMs}:${identity.packageName}::` +
      `${this.integer('install-slot', 100_000_000, 999_999_999)}:` +
      `app/~~${installA}/-${installB},`;

    const processEntries = PROCESS_ENTRY_TEMPLATES.map((template, index) => {
      const [sign, kind, ownerValue, first, second, third, metricDigits] = template;
      const magnitude = this.integerBig(
        `process-hash-${index}`,
        1_000_000_000_000_000_000,
        9_000_000_000_000_000_000,
      );
      const processHash = magnitude * BigInt(sign);
      const owner = ownerValue === null ? uid : ownerValue;
      const metric = this.requestInteger(
        `process-metric-${index}`,
        current,
        10 ** (metricDigits - 1),
        10 ** metricDigits - 1,
      );
      return `${processHash.toString()}:${kind}:${owner}_${first}_${second}_${third}_${metric}`;
    });

    const interfaceId = this.hex('interface-id', 3);
    const networkInterfaces =
      `8,eth0;69699;3;fe80::5054:ff:fe${interfaceId.slice(0, 2)}:${interfaceId.slice(2)};` +
      `fec0::5054:ff:fe${interfaceId.slice(0, 2)}:${interfaceId.slice(2)};10.0.2.15,` +
      'dummy0;65731;1;fe80::8c95:a4ff:fe59:322';

    const collectionLatency = this.requestInteger('collection-latency', current, 8000, 16000);

    const values = new Map(REFERENCE_NATIVE_FEATURES);
    const overrides: Record<number, string> = {
      16: identity.androidId,
      17: installContext,
      26: this.hex('native-device-id', 16),
      34: `C:1,T:${current},LT:${collectionLatency}`,
      125: processEntries.join(','),
      126: String(bootEpochMs),
      129: networkInterfaces,
      141: String(this.integer('native-property-141', 1_000_000, 9_999_999)),
      146: '1,272494655,eth0,10.0.2.15,10.0.2.3',
      148: identity.oaid,
    };
    for (const [tag, value] of Object.entries(overrides)) values.set(Number(tag), value);

    if (values.size !== 62) {
      throw new Error(`native feature map must contain 62 tags, got ${values.size}`);
    }
    return values;
  }

  /** 官方 52 键 Java Map，键顺序必须与 OFFICIAL_JAVA_KEYS 完全一致。 */
  featureMap(
    nowMs?: number,
    options: { fallbackStatusCode?: number; tokenNonce?: string } = {},
  ): Map<number | string, string> {
    const fallbackStatusCode = options.fallbackStatusCode ?? -22056;
    const identity = this.identity();
    const current = nowMs === undefined ? Date.now() : Math.trunc(nowMs);
    const native = this.nativeFeatureMap(current);
    const nonce = options.tokenNonce ?? this.hex(`diagnostic-nonce:${current}`, 16);
    const stageValues = [0, 1, 2].map((index) =>
      this.requestInteger(`stage-${index}`, current, 1000, 2200),
    );

    const n = (tag: number): string => {
      const value = native.get(tag);
      if (value === undefined) throw new Error(`native feature ${tag} missing`);
      return value;
    };
    const jdk = (tag: number): string => {
      const value = JAVA_SDK_CONSTANTS.get(tag);
      if (value === undefined) throw new Error(`java sdk constant ${tag} missing`);
      return value;
    };

    const map = new Map<number | string, string>([
      [1, identity.channel],
      [4, this.javaPerformanceContext(current)],
      [205, n(22)],
      [210, n(34)],
      [240, n(44)],
      [250, n(100)],
      [251, n(101)],
      [252, n(102)],
      [253, n(103)],
      [254, n(104)],
      [255, n(105)],
      [256, n(106)],
      [257, n(107)],
      [258, n(113)],
      [259, n(114)],
      [264, n(24)],
      [266, n(45)],
      [267, n(17)],
      [268, n(115)],
      [269, n(116)],
      [270, n(117)],
      [271, n(46)],
      [272, n(118)],
      [273, ''],
      [279, n(120)],
      [280, n(122)],
      [281, n(126)],
      [282, n(138)],
      [284, n(146)],
      [285, n(149)],
      [286, n(150)],
      [287, n(151)],
      [288, n(152)],
      [303, `5_1_${fallbackStatusCode}_${stageValues.join('_')}`],
      [308, '1'],
      [309, ''],
      [402, ''],
      [406, ''],
      [2001, n(200)],
      [2005, '0'],
      [2013, jdk(2013)],
      [2016, jdk(2016)],
      [2017, jdk(2017)],
      [2018, String(this.integer('uid', 10_000, 19_999))],
      [2019, n(133)],
      [2021, n(140)],
      [2029, '0'],
      [3001, String(fallbackStatusCode)],
      [3002, '1'],
      [3004, nonce],
      [3005, '1'],
      ['com.google.android.providers.gsf.permission.READ_GSERVICES', '1'],
    ]);

    const keys = [...map.keys()];
    if (keys.length !== OFFICIAL_JAVA_KEYS.length || keys.some((k, i) => k !== OFFICIAL_JAVA_KEYS[i])) {
      throw new Error('Java feature Map key order/coverage drifted');
    }
    return map;
  }
}

export interface ProfileState {
  schemaVersion: number;
  seedB64: string;
  bootEpochMs: number;
  installEpochMs: number;
  createdAt: string;
}

export function createProfileState(nowMs = Date.now()): ProfileState {
  const seed = randomBytes(32);
  const bootEpochMs = nowMs - Math.floor(Math.random() * (86_400_000 * 14 - 3_600_000)) - 3_600_000;
  const installEpochMs =
    bootEpochMs - Math.floor(Math.random() * (86_400_000 * 180 - 86_400_000)) - 86_400_000;
  return {
    schemaVersion: SCHEMA_VERSION,
    seedB64: seed.toString('base64'),
    bootEpochMs,
    installEpochMs,
    createdAt: new Date(nowMs).toISOString(),
  };
}

export function profileFromState(state: ProfileState): StableProfile {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('unsupported profile state schema');
  }
  return new StableProfile(Buffer.from(state.seedB64, 'base64'), {
    bootEpochMs: state.bootEpochMs,
    installEpochMs: state.installEpochMs,
  });
}
