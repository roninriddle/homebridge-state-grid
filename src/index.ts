import type { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, StateGridPlatform } from './platform.js';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, StateGridPlatform);
};
