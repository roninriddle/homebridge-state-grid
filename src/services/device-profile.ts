/**
 * 从持久化状态装配 App 请求档案。
 *
 * 平台进程和自定义 UI 进程都要用同一份装配逻辑——两边各写一遍迟早会漂移，
 * 而设备档案一旦不一致，服务端就会认为是另一台设备。
 */

import type { DeviceProfile } from '../sgcc/types.js';
import { DEFAULT_BASE_URL } from '../sgcc/types.js';
import { CLIENT_PRIVATE_KEY_HEX, SERVER_PUBLIC_KEY_HEX } from '../sgcc/crypto.js';
import type { StableProfile } from '../sgcc/turing-profile.js';
import type { PluginStore } from './store.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** App 的 60 位 AppGuid 由设备种子派生，保证跨重启一致。 */
export function stableAppGuid(bytes: Buffer): string {
  return [...bytes].map((value) => ALPHABET[value % ALPHABET.length]).join('');
}

export interface AssembledProfile {
  stable: StableProfile;
  device: DeviceProfile;
  /** 每次请求前用它刷新 token。 */
  refresh: () => { token: string; tokenTime: string };
}

export function assembleProfile(store: PluginStore): AssembledProfile {
  const stable = store.loadProfile();
  const identity = stable.identity();
  const token = store.deviceToken(stable);

  const device: DeviceProfile = {
    baseUrl: DEFAULT_BASE_URL,
    serverPublicKey: SERVER_PUBLIC_KEY_HEX,
    clientPrivateKey: CLIENT_PRIVATE_KEY_HEX,
    deviceTokenTx: token.token,
    deviceTokenTxTime: token.tokenTime,
    appGuid: stableAppGuid(stable.bytes('app-guid', 60)),
    deviceId: '000000',
    deviceModel: identity.model,
    androidRelease: identity.release,
    deviceIp: '127.0.0.1',
    operatorType: '',
    pushId: '000000',
    pushTokenAli: '000000',
    addressProvince: '',
    addressCity: '',
    addressRegion: '',
    provinceHeader: store.loadAccount()?.region ?? '',
    datacenter: '99',
  };

  return {
    stable,
    device,
    refresh: () => {
      const next = store.deviceToken(stable);
      return { token: next.token, tokenTime: next.tokenTime };
    },
  };
}
