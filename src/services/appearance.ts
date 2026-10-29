/** 摄像头名称与卡片地区显示共用一份解析规则。户号只作为内部标识。 */
import { regionFromAddress } from './summary.js';
export const DEFAULT_CAMERA_NAME = '国家电网';
export interface AccountAppearance { name?: string; showRegion?: boolean; }
export interface AppearanceConfig { showRegion?: boolean; accounts?: Array<{consNo?: string; title?: string; showRegion?: boolean}>; }
export function resolveAppearance(consNo: string, address: string, stored: AccountAppearance | undefined, config: AppearanceConfig = {}) {
  const configured = config.accounts?.find((item) => item.consNo === consNo);
  const name = (stored?.name !== undefined ? stored.name : configured?.title)?.trim() || DEFAULT_CAMERA_NAME;
  const showRegion = stored?.showRegion ?? configured?.showRegion ?? config.showRegion ?? false;
  return { name, showRegion, region: showRegion ? regionFromAddress(address) || undefined : undefined };
}
