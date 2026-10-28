/**
 * Homebridge 自定义设置页的后端入口。
 *
 * 职责只有三件：拿到 storage 目录、建 UiGateway、把接口挂上去。
 * 真正的逻辑在 `lib/gateway.js`，那里不 import 任何 Homebridge 东西。
 *
 * 为什么要单独跑一个进程：Homebridge 主进程里有我们的平台实例，但设置页
 * 由 homebridge-config-ui-x 在**另一个进程**里加载，两边唯一的共享面就是
 * storage 目录。所以登录态、设备种子、会话都从磁盘读，不跨进程传内存。
 */

'use strict';

const os = require('node:os');
const path = require('node:path');

const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');

const { UiGateway } = require('./lib/gateway.js');
const { registerRoutes } = require('./lib/routes.js');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // homebridgeStoragePath 是 HomebridgePluginUiServer 提供的字符串属性，
    // 直接指向当前 Homebridge 实例的 storage 目录（通常是 ~/.homebridge）。
    const storagePath =
      this.homebridgeStoragePath ||
      process.env.HOMEBRIDGE_STORAGE_PATH ||
      path.join(os.homedir(), '.homebridge');

    const gateway = new UiGateway(storagePath);
    registerRoutes(this, gateway);

    this.ready();
  }
}

(() => new UiServer())();
