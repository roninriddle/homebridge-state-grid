import type { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, StateGridPlatform } from './platform.js';

// Homebridge 通过 `require(plugin)` 拿到的必须是「接收 api 的注册函数」本身，
// 而不是挂在 `default` 上。所以这里用 `export =`（CommonJS 的 module.exports），
// 不能用 `export default`——后者会生成 `exports.default`，Homebridge 找不到入口。
export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, StateGridPlatform);
};
