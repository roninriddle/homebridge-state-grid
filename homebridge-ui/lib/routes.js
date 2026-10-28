/**
 * 设置页的接口表。
 *
 * 只依赖"有 onRequest(path, handler)"这个约定，不依赖具体框架——
 * 于是 `tools/ui-probe.mjs` 用一个假的 server 对象就能把整条链路跑通。
 */

'use strict';

const { describeError } = require('./gateway.js');

/** 所有接口都返回 { ok, ... }，异常也翻译成结构而不是抛给前端。 */
function safe(handler) {
  return async (payload) => {
    try {
      return await handler(payload || {});
    } catch (error) {
      return { ok: false, ...describeError(error) };
    }
  };
}

/**
 * @param {{ onRequest: (path: string, handler: Function) => void }} server
 * @param {import('./gateway.js').UiGateway} gateway
 */
function registerRoutes(server, gateway) {
  /** 打开页面先读这个：纯本地，不发网络请求。 */
  server.onRequest(
    '/status',
    safe(async () => ({ ok: true, ...gateway.status() })),
  );

  /** 账号密码登录。返回 need_device_sms 时前端切换到验证码模式。 */
  server.onRequest(
    '/login',
    safe(async (payload) => gateway.login({ username: payload.username, password: payload.password })),
  );

  /** 发送短信验证码，payload.kind 为 'device' | 'login'。 */
  server.onRequest(
    '/send-sms',
    safe(async (payload) => gateway.sendSms(payload.kind === 'login' ? 'login' : 'device')),
  );

  /** 提交验证码。 */
  server.onRequest(
    '/verify',
    safe(async (payload) => gateway.verify(payload.code)),
  );

  /** 拉户号列表。 */
  server.onRequest(
    '/accounts',
    safe(async () => gateway.accounts()),
  );

  /** 单户号数据 + 卡片预览图。 */
  server.onRequest(
    '/preview',
    safe(async (payload) =>
      gateway.preview(payload.consNo, { theme: payload.theme, title: payload.title }),
    ),
  );

  /** 换手机号/密码之后必须丢掉旧的客户端，否则还用旧凭据。 */
  server.onRequest(
    '/reset',
    safe(async () => {
      gateway.resetClient();
      return { ok: true, ...gateway.status() };
    }),
  );
}

module.exports = { registerRoutes };
