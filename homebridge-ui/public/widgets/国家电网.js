// 国家电网 · Homebridge State Grid · Scriptable
// 在 Scriptable 中运行一次完成配置，再添加桌面小组件。
// 多个小组件可在“Parameter”中填写不同档案名；留空使用“默认”。
const SETTINGS_KEY = 'homebridge-state-grid.widgets.v1';
const fm = FileManager.local();
const cacheRoot = fm.joinPath(fm.documentsDirectory(), 'state-grid-widget-cache');
if (!fm.fileExists(cacheRoot)) fm.createDirectory(cacheRoot, true);
let profiles = {};
try {const saved = Keychain.contains(SETTINGS_KEY) ? JSON.parse(Keychain.get(SETTINGS_KEY)) : {}; if (saved && typeof saved === 'object' && !Array.isArray(saved)) profiles = saved;} catch { /* 损坏配置可重新建立 */ }
const cacheFile = name => fm.joinPath(cacheRoot, encodeURIComponent(name) + '.json');
function clearCache(name) {const file = cacheFile(name); if (fm.fileExists(file)) fm.remove(file);}
function origin(value) {
  const clean = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(clean)) throw new Error('地址应为 http://主机IP:端口 或 HTTPS 域名，不含路径、用户名或令牌');
  return clean;
}
async function load(profile) {
  const request = new Request(profile.server + '/v1/widget');
  request.headers = {Authorization: 'Bearer ' + profile.token};
  request.timeoutInterval = 10;
  request.onRedirect = () => null; // 令牌不跟随重定向发送到其他地址。
  let data;
  try {data = await request.loadJSON();}
  catch {
    const error = new Error('连接失败');
    error.forgetCache = request.response && [401, 403, 404].includes(request.response.statusCode); throw error;
  }
  const status = request.response ? request.response.statusCode : 0;
  if (status !== 200) {
    const error = new Error(data.error || '接口暂不可用');
    error.forgetCache = [401, 403, 404].includes(status); throw error;
  }
  if (data.schemaVersion !== 1 || !Array.isArray(data.accounts)) throw new Error('小组件数据版本不兼容');
  return data;
}
async function configure(existingName) {
  const previous = profiles[existingName] || {};
  const alert = new Alert(); alert.title = '配置国家电网小组件';
  alert.message = '在插件的“iOS 小组件”页启用接口并生成令牌。地址使用小组件端口，不是 Homebridge 管理页端口。';
  alert.addTextField('档案名', existingName || '默认');
  alert.addTextField('http://Homebridge主机IP:19861', previous.server || '');
  alert.addSecureTextField('独立访问令牌', previous.token || '');
  alert.addAction('读取户号'); alert.addCancelAction('取消');
  if (await alert.presentAlert() < 0) return null;
  const name = alert.textFieldValue(0).trim();
  if (!name || name.length > 40 || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('请填写 1～40 字的档案名');
  const profile = {server: origin(alert.textFieldValue(1)), token: alert.textFieldValue(2).trim(), account: ''};
  if (!/^[A-Za-z0-9_-]{43}$/.test(profile.token)) throw new Error('请复制插件新生成的完整令牌');
  const data = await load(profile);
  if (!data.accounts.length) throw new Error('暂无启用户号，请先在插件中启用户号并获取数据');
  const choice = new Alert(); choice.title = '选择用电卡片';
  data.accounts.forEach((a, i) => choice.addAction(`${a.title}${a.region ? ' · ' + a.region : ''} · 卡片 ${i + 1}`));
  choice.addCancelAction('取消'); const index = await choice.presentSheet();
  if (index < 0) return null;
  profile.account = data.accounts[index].id;
  clearCache(name); profiles[name] = profile;
  Keychain.set(SETTINGS_KEY, JSON.stringify(profiles)); return name;
}
function text(stack, value, font, color) {
  const label = stack.addText(String(value)); label.font = font; label.textColor = color;
  label.lineLimit = 1; label.minimumScaleFactor = 0.55; return label;
}
function time(value) {if (!value) return '尚未更新'; const f = new DateFormatter(); f.dateFormat = 'MM-dd HH:mm'; f.timeZone = 'Asia/Shanghai'; return f.string(new Date(value));}
function render(account, note) {
  const widget = new ListWidget(); const dark = account && account.theme === 'dark';
  const ink = new Color(dark ? 'f0f5fa' : '14362e'), muted = new Color(dark ? '9bafbb' : '65796f'), accent = new Color(dark ? '61dca6' : '00875b');
  widget.backgroundColor = new Color(dark ? '10232b' : 'f3faf6'); widget.setPadding(14, 14, 12, 14);
  widget.url = URLScheme.forRunningScript(); widget.refreshAfterDate = new Date(Date.now() + 3600000);
  if (!account) {text(widget, '国家电网', Font.semiboldSystemFont(16), accent); widget.addSpacer(10); const message = widget.addText(note || '请先在 Scriptable 中运行并配置'); message.font = Font.systemFont(12); message.textColor = muted; widget.addSpacer(); return widget;}
  const family = config.widgetFamily || 'medium';
  text(widget, account.title || '国家电网', Font.semiboldSystemFont(14), accent);
  if (family === 'large' && account.region) text(widget, account.region, Font.systemFont(10), muted);
  widget.addSpacer(family === 'large' ? 12 : 6);
  const metrics = account.metrics.slice(0, family === 'small' ? 2 : family === 'large' ? 8 : 4);
  function cell(stack, metric, primary) {
    const column = stack.addStack(); column.layoutVertically();
    if (family !== 'small') column.size = new Size(Math.floor((Device.screenSize().width - 100) / 2), 0);
    text(column, metric.label, Font.systemFont(primary ? 10 : 9), muted);
    column.addSpacer(2);
    const line = column.addStack(); line.bottomAlignContent();
    text(line, metric.text, primary ? Font.boldSystemFont(family === 'small' ? 25 : 26) : Font.semiboldSystemFont(17), ink);
    line.addSpacer(3); text(line, metric.unit, Font.systemFont(9), muted);
  }
  if (family === 'small') {
    for (let i = 0; i < metrics.length; i++) {cell(widget, metrics[i], true); if (i === 0) widget.addSpacer(4);}
  } else {
    for (let i = 0; i < metrics.length; i += 2) {
      const row = widget.addStack(); row.layoutHorizontally(); cell(row, metrics[i], i < 2);
      row.addSpacer(); if (metrics[i + 1]) cell(row, metrics[i + 1], i < 2);
      if (i + 2 < metrics.length) widget.addSpacer(family === 'large' ? 12 : 6);
    }
  }
  widget.addSpacer();
  text(widget, (note || (account.stale ? '缓存 · ' : '更新 ')) + time(account.updatedAt), Font.systemFont(9), muted);
  return widget;
}
async function main() {
  let name = String(args.widgetParameter || '默认').trim();
  if (!config.runsInWidget) {
    const menu = new Alert(); menu.title = '国家电网小组件';
    const names = Object.keys(profiles); names.forEach(n => menu.addAction('预览 · ' + n));
    menu.addAction('新增或重新配置'); menu.addAction('删除档案'); menu.addCancelAction('取消');
    const action = await menu.presentSheet(); if (action < 0) return;
    if (action < names.length) name = names[action];
    else if (action === names.length) {name = await configure(''); if (!name) return;}
    else {
      if (!names.length) return;
      const remove = new Alert(); remove.title = '删除哪个档案？'; names.forEach(n => remove.addAction(n)); remove.addCancelAction('取消');
      const index = await remove.presentSheet(); if (index < 0) return;
      clearCache(names[index]); delete profiles[names[index]]; Keychain.set(SETTINGS_KEY, JSON.stringify(profiles)); return;
    }
  }
  const profile = Object.prototype.hasOwnProperty.call(profiles, name) ? profiles[name] : null;
  let account = null, note = '';
  if (profile) {
    try {
      const data = await load(profile); account = data.accounts.find(a => a.id === profile.account);
      if (!account) {clearCache(name); note = '户号已停用或移除，请重新配置';}
      else fm.writeString(cacheFile(name), JSON.stringify(account));
    } catch (error) {
      if (error.forgetCache) {clearCache(name); note = '令牌已失效，请重新配置';}
      else {
        try {account = JSON.parse(fm.readString(cacheFile(name)));} catch { /* 首次离线 */ }
        note = account ? '离线缓存 · ' : '连接失败，请检查局域网或 VPN';
      }
    }
  } else note = '请运行脚本配置档案“' + name + '”';
  const widget = render(account, note);
  Script.setWidget(widget);
  if (!config.runsInWidget) await widget.presentMedium();
}
try {await main();} catch {const widget = render(null, '配置失败，请检查地址、端口和令牌后重试'); Script.setWidget(widget); if (!config.runsInWidget) await widget.presentMedium();}
Script.complete();
