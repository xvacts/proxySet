importScripts('validation.js');

// Preserve the existing installation and explicit-disable behavior.
const DEFAULTS = { host: '192.168.100.1', port: 7896, scheme: 'socks5', enabled: true };
const SETTINGS_KEYS = ['host', 'port', 'scheme', 'enabled', 'note', 'blockWhenDisabled'];
const BLOCK_RULE_ID = 10001;
const BLOCK_RULE = {
  id: BLOCK_RULE_ID, priority: 1, action: { type: 'block' },
  // Explicit empty exclusions include main_frame and future resource types.
  condition: { urlFilter: '*', excludedResourceTypes: [] }
};
let pending = Promise.resolve();

async function updateToolbar(enabled, error = '', blocked = false) {
  const state = enabled ? 'on' : 'off';
  const path = Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/proxy-${state}-${size}.png`]));
  const title = error ? 'Proxy：状态未确认，请打开设置检查' :
    enabled ? 'Proxy：代理已启用' : blocked ? 'Proxy：代理已禁用，网页联网已阻断' : 'Proxy：代理已禁用（直连）';
  try {
    await Promise.all([
      new Promise((resolve, reject) => chrome.action.setIcon({ path }, () => {
        if (chrome.runtime.lastError) reject(new Error('图标更新失败'));
        else resolve();
      })),
      new Promise((resolve, reject) => chrome.action.setTitle({ title }, () => {
        if (chrome.runtime.lastError) reject(new Error('提示更新失败'));
        else resolve();
      }))
    ]);
  } catch { console.warn('工具栏状态更新失败'); }
}

function proxyCall(method, details) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings[method](details, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error('浏览器拒绝代理操作，请检查扩展权限或管理策略'));
      else resolve(result);
    });
  });
}

function readSettings(data) {
  if (data.blockWhenDisabled !== undefined && typeof data.blockWhenDisabled !== 'boolean') {
    throw new Error('断网选项无效');
  }
  return { ...validateProxySettings(data), blockWhenDisabled: data.blockWhenDisabled === true };
}

async function requireCurrentSettings(data) {
  const current = readSettings(await chrome.storage.local.get(SETTINGS_KEYS));
  if (JSON.stringify(current) !== JSON.stringify(readSettings(data))) {
    throw new Error('设置已更新，已取消过期操作；请等待最新设置生效');
  }
}

function rulesCall(method, details) {
  return new Promise((resolve, reject) => {
    const done = result => {
      if (chrome.runtime.lastError) reject(new Error('网页阻断规则操作失败，请检查扩展权限'));
      else resolve(result);
    };
    if (details === undefined) chrome.declarativeNetRequest[method](done);
    else chrome.declarativeNetRequest[method](details, done);
  });
}

async function blockIsActive() {
  const rules = await rulesCall('getDynamicRules');
  const rule = rules.find(item => item.id === BLOCK_RULE_ID);
  if (!rule) return false;
  if (rule.action.type !== 'block' || rule.condition.urlFilter !== '*' ||
      !Array.isArray(rule.condition.excludedResourceTypes) || rule.condition.excludedResourceTypes.length ||
      Object.keys(rule.condition).length !== 2 || Object.keys(rule.action).length !== 1) {
    throw new Error('网页阻断规则异常，请重新应用设置');
  }
  return true;
}

async function setBlock(active) {
  await rulesCall('updateDynamicRules', {
    removeRuleIds: [BLOCK_RULE_ID], addRules: active ? [BLOCK_RULE] : []
  });
  if (await blockIsActive() !== active) throw new Error('网页阻断规则未生效');
}

async function verifyProxy(expected) {
  const effective = await proxyCall('get', { incognito: false });
  if (effective.levelOfControl !== 'controlled_by_this_extension') {
    throw new Error('代理未由本扩展控制，请检查其他扩展或管理策略');
  }
  if (expected.enabled) {
    const actual = effective.value?.rules?.singleProxy;
    if (effective.value?.mode !== 'fixed_servers' || !actual ||
        actual.host !== expected.host || actual.port !== expected.port || actual.scheme !== expected.scheme) {
      throw new Error('浏览器当前代理与保存配置不一致');
    }
  } else if (effective.value?.mode !== 'direct') {
    throw new Error('浏览器尚未切换到直连模式');
  }
}

async function readStatus(data) {
  const expected = readSettings(data);
  const blocked = await blockIsActive();
  if (blocked !== (!expected.enabled && expected.blockWhenDisabled)) {
    throw new Error('网页阻断状态与保存配置不一致，请重新应用设置');
  }
  // A confirmed browser block remains effective regardless of proxy ownership.
  if (!blocked) await verifyProxy(expected);
  await requireCurrentSettings(data);
  await updateToolbar(expected.enabled, '', blocked);
  return { success: true, ...expected, blocked, note: typeof data.note === 'string' ? data.note : '' };
}

async function applyProxy() {
  const data = await chrome.storage.local.get(SETTINGS_KEYS);
  const settings = readSettings(data);
  if (!settings.enabled && settings.blockWhenDisabled) {
    // Do not switch to direct mode when the user asked to block browsing.
    await setBlock(true);
    return readStatus(data);
  }
  const value = settings.enabled ? {
    mode: 'fixed_servers',
    rules: { singleProxy: { scheme: settings.scheme, host: settings.host, port: settings.port } }
  } : { mode: 'direct' };
  // Invalid configuration leaves the current browser proxy untouched.
  await proxyCall('set', { value, scope: 'regular' });
  // Keep any existing block until proxy/direct configuration is confirmed.
  await verifyProxy(settings);
  // Storage writes are not serialized by our API queue. Never release an
  // existing block using a snapshot superseded by a newer user selection.
  await requireCurrentSettings(data);
  await setBlock(false);
  return readStatus(data);
}

function enqueue(operation) {
  const result = pending.then(async () => {
    try { return await operation(); }
    catch (error) {
      await updateToolbar(false, error.message);
      throw error;
    }
  });
  pending = result.catch(() => {});
  return result;
}

function applySafely() {
  enqueue(applyProxy).catch(() => console.warn('代理配置未能应用，请打开弹窗检查状态'));
}

chrome.runtime.onInstalled.addListener(details => {
  enqueue(async () => {
    const settings = await chrome.storage.local.get(SETTINGS_KEYS);
    // Reloads also fire onInstalled. Only initialize a genuinely new install;
    // missing settings must never override a disabled state or surviving block.
    if (details?.reason === 'install' && Object.keys(settings).length === 0 && !await blockIsActive()) {
      await chrome.storage.local.set(DEFAULTS);
    }
    return applyProxy();
  }).catch(() => console.warn('代理初始化失败，请打开弹窗检查状态'));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['host', 'port', 'scheme', 'enabled', 'blockWhenDisabled'].some(key => Object.prototype.hasOwnProperty.call(changes, key))) {
    applySafely();
  }
});

// Refresh visuals without taking control back from policy or another extension.
function refreshToolbar() {
  enqueue(async () => readStatus(await chrome.storage.local.get(SETTINGS_KEYS))).catch(() => {});
}

chrome.proxy.settings.onChange.addListener(refreshToolbar);
chrome.runtime.onStartup.addListener(refreshToolbar);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
    sendResponse({ success: false, error: '消息来源不受信任' });
    return false;
  }
  if (!msg || typeof msg !== 'object' || !['applyProxy', 'getStatus'].includes(msg.action)) {
    sendResponse({ success: false, error: '无效操作' });
    return false;
  }
  enqueue(async () => msg.action === 'applyProxy' ? applyProxy() :
    readStatus(await chrome.storage.local.get(SETTINGS_KEYS)))
    .then(sendResponse, error => sendResponse({ success: false, error: error.message }));
  return true;
});

// Service workers restart independently of browser startup and popup opening.
refreshToolbar();
