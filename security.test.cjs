const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, name), 'utf8');

function environment(initial = {}, options = {}) {
  const data = options.emptyStorage ? {} : { host: '192.168.100.1', port: 7896, scheme: 'socks5', enabled: true, ...initial };
  const listeners = {};
  const calls = [];
  const toolbar = { icons: [], titles: [] };
  const events = [];
  let dynamicRules = structuredClone(options.rules || []);
  let effective = options.effective || { mode: 'direct' };
  const chrome = {
    runtime: {
      id: 'test', getURL: name => `chrome-extension://test/${name}`,
      onInstalled: { addListener: fn => listeners.install = fn },
      onStartup: { addListener: fn => listeners.startup = fn },
      onMessage: { addListener: fn => listeners.message = fn }
    },
    storage: {
      local: {
        get: async keys => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async values => Object.assign(data, values)
      },
      onChanged: { addListener: fn => listeners.change = fn }
    },
    action: {
      setIcon(details, callback) { toolbar.icons.push(details.path); callback(); },
      setTitle(details, callback) { toolbar.titles.push(details.title); callback(); }
    },
    declarativeNetRequest: {
      getDynamicRules(callback) { callback(structuredClone(dynamicRules)); },
      updateDynamicRules(details, callback) {
        events.push({ type: 'rules', details });
        if (options.rulesError) chrome.runtime.lastError = { message: 'rules permission denied' };
        else dynamicRules = [...dynamicRules.filter(rule => !details.removeRuleIds.includes(rule.id)), ...structuredClone(details.addRules)];
        callback();
        delete chrome.runtime.lastError;
      }
    },
    proxy: { settings: {
      onChange: { addListener: fn => listeners.proxyChange = fn },
      set(details, callback) {
        events.push({ type: 'proxy', details });
        calls.push(details);
        if (options.setError) chrome.runtime.lastError = { message: 'private internal detail' };
        else effective = details.value;
        if (options.afterProxySet) options.afterProxySet(data);
        callback();
        delete chrome.runtime.lastError;
      },
      get(details, callback) {
        callback({ value: effective, levelOfControl: options.control || 'controlled_by_this_extension' });
      }
    } }
  };
  const context = vm.createContext({ chrome, URL, console: { warn() {} } });
  context.importScripts = name => vm.runInContext(source(name), context);
  vm.runInContext(source('background.js'), context);
  const sender = { id: 'test', url: chrome.runtime.getURL('popup.html') };
  const message = (msg = { action: 'applyProxy' }, origin = sender) => new Promise(resolve => {
    const keepAlive = listeners.message(msg, origin, resolve);
    assert.equal(typeof keepAlive, 'boolean');
  });
  return { context, chrome, data, listeners, calls, message, toolbar, events,
    getRules() { return dynamicRules; },
    replaceEffective(value) { effective = value; } };
}

test('valid IPv4, ASCII hostname, IPv6 and boundary ports are accepted', () => {
  const { context } = environment();
  for (const host of ['127.0.0.1', 'proxy.example.com', 'localhost', 'xn--fsqu00a.xn--0zwm56d', '::1', '[2001:db8::1]']) {
    for (const port of [1, '65535']) {
      context.input = { host, port, scheme: 'http', enabled: true };
      assert.equal(vm.runInContext('validateProxySettings(input).port', context), Number(port));
    }
  }
});

test('malformed addresses, protocols, ports and enabled types are rejected at worker boundary', async () => {
  const bad = [
    { host: '<img src=x>' }, { host: 'http://proxy.example' }, { host: 'user:pass@proxy' },
    { host: 'proxy/path' }, { host: 'proxy:8080' }, { host: 'proxy\n.example' },
    { host: '999.1.1.1' }, { host: '127.1' }, { host: '[:::1]' },
    { scheme: 'https' }, { port: '7896evil' }, { port: '1e3' }, { port: 1.5 },
    { port: 0 }, { port: 65536 }, { port: null }, { enabled: 'false' }
  ];
  for (const input of bad) {
    const env = environment(input);
    assert.equal((await env.message()).success, false, JSON.stringify(input));
    assert.equal(env.calls.length, 0, 'invalid config must never force direct or replace existing proxy');
  }
});

test('successful apply responds only after set/get and confirms configuration', async () => {
  const env = environment({ port: '7896' });
  const result = await env.message();
  assert.equal(result.success, true);
  assert.equal(result.port, 7896);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].value.mode, 'fixed_servers');
});

test('explicit disable preserves direct mode even with invalid host', async () => {
  const env = environment({ enabled: false, host: '<invalid>' });
  assert.equal((await env.message()).success, true);
  assert.equal(env.calls[0].value.mode, 'direct');
});

test('API errors and policy/other extension control never report success', async () => {
  for (const options of [{ setError: true }, { control: 'controlled_by_other_extensions' }, { control: 'not_controllable' }]) {
    const result = await environment({}, options).message();
    assert.equal(result.success, false);
    assert.ok(!result.error.includes('private internal detail'));
  }
});

test('stored enabled flag alone is insufficient to claim effective proxy', async () => {
  const env = environment();
  assert.equal((await env.message({ action: 'getStatus' })).success, false);
  assert.equal(env.calls.length, 0);
});

test('messages from unrelated IDs, pages, content scripts and malformed requests rejected', async () => {
  const env = environment();
  for (const sender of [
    { id: 'other', url: 'chrome-extension://test/popup.html' },
    { id: 'test', url: 'https://example.com' },
    { id: 'test', url: 'chrome-extension://test/popup.html', tab: {} }
  ]) assert.equal((await env.message({ action: 'applyProxy' }, sender)).success, false);
  for (const msg of [null, {}, 'applyProxy', { action: 'unknown' }]) {
    assert.equal((await env.message(msg)).success, false);
  }
  assert.equal(env.calls.length, 0);
});

test('fresh install preserves configured default and enables it', async () => {
  const env = environment({}, { emptyStorage: true });
  env.listeners.install({ reason: 'install' });
  await vm.runInContext('pending', env.context);
  assert.equal(env.data.host, '192.168.100.1');
  assert.equal(env.data.enabled, true);
  assert.equal(env.calls.at(-1).value.mode, 'fixed_servers');
});

test('reload with missing host must preserve disabled state and persistent block', async () => {
  const env = environment({ enabled: false, blockWhenDisabled: true });
  await env.message();
  delete env.data.host;
  env.listeners.install({ reason: 'update' });
  await vm.runInContext('pending', env.context);
  assert.equal(env.data.enabled, false);
  assert.equal(env.getRules().length, 1);
  assert.equal(env.calls.length, 0);
});

test('reload with empty storage must not replace a surviving block with defaults', async () => {
  const env = environment({ enabled: false, blockWhenDisabled: true });
  await env.message();
  for (const key of Object.keys(env.data)) delete env.data[key];
  env.listeners.install({ reason: 'update' });
  await vm.runInContext('pending', env.context);
  assert.equal(env.data.enabled, undefined);
  assert.equal(env.getRules().length, 1);
  assert.equal(env.calls.length, 0);
});

test('obsolete apply must not remove a block after newer settings request blocked mode', async () => {
  const options = {};
  const env = environment({ enabled: false, blockWhenDisabled: true }, options);
  await env.message();
  env.data.enabled = true;
  options.afterProxySet = data => { data.enabled = false; };
  const result = await env.message();
  assert.equal(result.success, false);
  assert.equal(env.getRules().length, 1);
});

test('popup cannot overwrite saved block option before asynchronous settings load', async () => {
  let loaded;
  let resolveSettings;
  const writes = [];
  const loading = new Promise(resolve => { resolveSettings = resolve; });
  const elements = {};
  for (const id of ['scheme', 'host', 'port', 'note', 'status', 'save', 'disable', 'blockWhenDisabled']) {
    elements[id] = { value: '', checked: false, addEventListener(event, fn) { this[event] = fn; } };
  }
  const context = vm.createContext({ URL, document: {
    addEventListener(event, fn) { loaded = fn; }, getElementById: id => elements[id]
  }, chrome: {
    storage: { local: { get: () => loading, set: async values => writes.push(values) } },
    runtime: { sendMessage: async () => ({ success: true, enabled: false, blocked: true }) }
  } });
  vm.runInContext(source('validation.js'), context);
  vm.runInContext(source('popup.js'), context);
  const initialLoad = loaded();
  assert.equal(elements.disable.disabled, true);
  assert.equal(elements.blockWhenDisabled.disabled, true);
  await elements.disable.click();
  assert.equal(writes.length, 0);
  resolveSettings({ blockWhenDisabled: true });
  await initialLoad;
  assert.equal(elements.disable.disabled, false);
  assert.equal(elements.blockWhenDisabled.checked, true);
  assert.match(source('popup.html'), /id="blockWhenDisabled" disabled/);
  assert.match(source('popup.html'), /id="disable" disabled/);
});

test('storage read failure leaves popup controls locked instead of saving fallback values', async () => {
  let loaded;
  let writes = 0;
  const elements = {};
  for (const id of ['scheme', 'host', 'port', 'note', 'status', 'save', 'disable', 'blockWhenDisabled']) {
    elements[id] = { value: '', checked: false, addEventListener(event, fn) { this[event] = fn; } };
  }
  const context = vm.createContext({ URL, document: {
    addEventListener(event, fn) { loaded = fn; }, getElementById: id => elements[id]
  }, chrome: {
    storage: { local: { get: async () => { throw new Error('storage unavailable'); }, set: async () => { writes++; } } },
    runtime: { sendMessage: async () => ({ success: true }) }
  } });
  vm.runInContext(source('validation.js'), context);
  vm.runInContext(source('popup.js'), context);
  await loaded();
  await elements.disable.click();
  await elements.blockWhenDisabled.change();
  assert.equal(writes, 0);
  assert.equal(elements.save.disabled, true);
  assert.equal(elements.disable.disabled, true);
  assert.match(elements.status.textContent, /storage unavailable/);
});

test('unrelated local storage changes do not reapply proxy', async () => {
  const env = environment();
  env.listeners.change({ note: { newValue: 'test' } }, 'local');
  env.listeners.change({ host: { newValue: 'test' } }, 'sync');
  await vm.runInContext('pending', env.context);
  assert.equal(env.calls.length, 0);
});

test('concurrent requests are serialized and settle', async () => {
  const env = environment();
  const results = await Promise.all([env.message(), env.message(), env.message()]);
  assert.ok(results.every(r => r.success));
  assert.equal(env.calls.length, 3);
});

test('popup renders attack markup as literal text and handles background failure', async () => {
  const attack = '<img src="https://attacker.invalid/x"><form>fake login</form>';
  let loaded;
  let response = { success: true, enabled: true, scheme: 'http', host: 'localhost', port: 80, note: attack };
  const elements = {};
  for (const id of ['scheme', 'host', 'port', 'note', 'status', 'save', 'disable', 'blockWhenDisabled']) {
    elements[id] = { value: '', addEventListener(event, fn) { this[event] = fn; } };
    Object.defineProperty(elements[id], 'innerHTML', { set() { throw new Error('HTML sink used'); } });
  }
  const context = vm.createContext({ URL, document: {
    addEventListener(event, fn) { loaded = fn; }, getElementById: id => elements[id]
  }, chrome: {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { sendMessage: async () => response }
  } });
  vm.runInContext(source('validation.js'), context);
  vm.runInContext(source('popup.js'), context);
  await loaded();
  assert.ok(elements.status.textContent.includes(attack));
  elements.port.value = '7896';
  response = { success: false, error: 'policy denied' };
  await elements.save.click();
  assert.ok(elements.status.textContent.includes('policy denied'));
  assert.equal(elements.save.disabled, false);
});

test('manifest and resource references stay local with minimum permissions', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.deepEqual(manifest.permissions, ['proxy', 'storage', 'declarativeNetRequest']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
  for (const match of source('popup.html').matchAll(/<script src="([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(__dirname, match[1])));
  }
  assert.ok(!source('popup.js').includes('.innerHTML'));
});

test('toolbar turns green after confirmed enable and gray after disable', async () => {
  const env = environment();
  await env.message();
  assert.equal(env.toolbar.icons.at(-1)[16], 'icons/proxy-on-16.png');
  assert.match(env.toolbar.titles.at(-1), /代理已启用/);
  env.data.enabled = false;
  await env.message();
  assert.equal(env.toolbar.icons.at(-1)[32], 'icons/proxy-off-32.png');
  assert.match(env.toolbar.titles.at(-1), /代理已禁用/);
});

test('failed apply clears previously green toolbar and reports uncertain status', async () => {
  const options = {};
  const env = environment({}, options);
  await env.message();
  options.setError = true;
  assert.equal((await env.message()).success, false);
  assert.equal(env.toolbar.icons.at(-1)[16], 'icons/proxy-off-16.png');
  assert.match(env.toolbar.titles.at(-1), /状态未确认/);
});

test('external proxy changes refresh icon without rewriting browser proxy', async () => {
  const env = environment();
  await env.message();
  env.replaceEffective({ mode: 'system' });
  env.listeners.proxyChange();
  await vm.runInContext('pending', env.context);
  assert.equal(env.toolbar.icons.at(-1)[16], 'icons/proxy-off-16.png');
  assert.equal(env.calls.length, 1);
});

test('worker and browser startup restore icon from actual proxy state', async () => {
  const env = environment({}, { effective: {
    mode: 'fixed_servers', rules: { singleProxy: { scheme: 'socks5', host: '192.168.100.1', port: 7896 } }
  } });
  await vm.runInContext('pending', env.context);
  assert.equal(env.toolbar.icons.at(-1)[16], 'icons/proxy-on-16.png');
  env.replaceEffective({ mode: 'direct' });
  env.data.enabled = false;
  env.listeners.startup();
  await vm.runInContext('pending', env.context);
  assert.equal(env.toolbar.icons.at(-1)[16], 'icons/proxy-off-16.png');
  assert.equal(env.calls.length, 0);
});

test('both toolbar icon states are valid PNGs at every declared size', () => {
  const manifest = JSON.parse(source('manifest.json'));
  for (const size of [16, 32, 48, 128]) {
    assert.equal(manifest.action.default_icon[size], `icons/proxy-off-${size}.png`);
    for (const state of ['on', 'off']) {
      const png = fs.readFileSync(path.join(__dirname, `icons/proxy-${state}-${size}.png`));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  }
});

test('disable with block option installs persistent all-resource rule and never sets direct', async () => {
  const env = environment({ enabled: false, blockWhenDisabled: true }, { control: 'controlled_by_other_extensions' });
  const result = await env.message();
  assert.equal(result.success, true);
  assert.equal(result.blocked, true);
  assert.equal(env.calls.length, 0);
  const rule = env.getRules().find(rule => rule.id === 10001);
  assert.equal(rule.action.type, 'block');
  assert.equal(rule.condition.urlFilter, '*');
  assert.equal(rule.condition.excludedResourceTypes.length, 0, 'must include top-level navigations as well as subresources');
  assert.equal(env.toolbar.icons.at(-1)[16], 'icons/proxy-off-16.png');
  assert.match(env.toolbar.titles.at(-1), /联网已阻断/);
});

test('re-enable sets and verifies proxy before removing block', async () => {
  const env = environment({ enabled: false, blockWhenDisabled: true });
  await env.message();
  env.data.enabled = true;
  const eventCount = env.events.length;
  const result = await env.message();
  assert.equal(result.success, true);
  assert.equal(result.blocked, false);
  const transition = env.events.slice(eventCount);
  assert.equal(transition[0].type, 'proxy');
  assert.equal(transition[0].details.value.mode, 'fixed_servers');
  assert.equal(transition[1].type, 'rules');
  assert.equal(transition[1].details.addRules.length, 0);
  assert.equal(env.getRules().length, 0);
});

test('failed re-enable or policy conflict preserves existing browser block', async () => {
  for (const failure of [{ setError: true }, { control: 'not_controllable' }]) {
    const options = {};
    const env = environment({ enabled: false, blockWhenDisabled: true }, options);
    await env.message();
    env.data.enabled = true;
    Object.assign(options, failure);
    const result = await env.message();
    assert.equal(result.success, false);
    assert.equal(env.getRules().length, 1);
  }
});

test('unchecking block while disabled restores direct mode before removing rule', async () => {
  const env = environment({ enabled: false, blockWhenDisabled: true });
  await env.message();
  env.data.blockWhenDisabled = false;
  const result = await env.message();
  assert.equal(result.success, true);
  assert.equal(result.blocked, false);
  assert.equal(env.calls.at(-1).value.mode, 'direct');
  assert.equal(env.getRules().length, 0);
});

test('block API failure never falls back to direct or claims blocked', async () => {
  const env = environment({ enabled: false, blockWhenDisabled: true }, { rulesError: true });
  const result = await env.message();
  assert.equal(result.success, false);
  assert.equal(env.calls.length, 0);
  assert.equal(env.getRules().length, 0);
});

test('persisted block is recognized on worker and browser startup without clearing it', async () => {
  const first = environment({ enabled: false, blockWhenDisabled: true });
  await first.message();
  const env = environment({ enabled: false, blockWhenDisabled: true }, { rules: first.getRules(), control: 'not_controllable' });
  await vm.runInContext('pending', env.context);
  assert.match(env.toolbar.titles.at(-1), /联网已阻断/);
  env.listeners.startup();
  await vm.runInContext('pending', env.context);
  assert.equal(env.getRules().length, 1);
  assert.equal(env.calls.length, 0);
});

test('non-boolean preference and missing/malformed blocking rules cannot claim safe state', async () => {
  const invalid = environment({ enabled: false, blockWhenDisabled: 'true' });
  assert.equal((await invalid.message()).success, false);
  assert.equal(invalid.calls.length, 0);
  const missing = environment({ enabled: false, blockWhenDisabled: true });
  assert.equal((await missing.message({ action: 'getStatus' })).success, false);
  const malformed = environment({ enabled: false, blockWhenDisabled: true }, { rules: [{
    id: 10001, action: { type: 'block' }, condition: { urlFilter: '*', resourceTypes: ['image'] }
  }] });
  assert.equal((await malformed.message({ action: 'getStatus' })).success, false);
});

test('popup saves block preference immediately, preserves enable flag and shows blocked mode', async () => {
  let loaded;
  const saved = [];
  const elements = {};
  for (const id of ['scheme', 'host', 'port', 'note', 'status', 'save', 'disable', 'blockWhenDisabled']) {
    elements[id] = { value: '', addEventListener(event, fn) { this[event] = fn; } };
  }
  const context = vm.createContext({ URL, document: {
    addEventListener(event, fn) { loaded = fn; }, getElementById: id => elements[id]
  }, chrome: {
    storage: { local: { get: async () => ({ blockWhenDisabled: true }), set: async values => saved.push(values) } },
    runtime: { sendMessage: async () => ({ success: true, enabled: false, blocked: true }) }
  } });
  vm.runInContext(source('validation.js'), context);
  vm.runInContext(source('popup.js'), context);
  await loaded();
  assert.equal(elements.blockWhenDisabled.checked, true);
  assert.match(elements.disable.textContent, /阻断/);
  assert.match(elements.status.textContent, /联网已阻断/);
  await elements.blockWhenDisabled.change();
  assert.equal(saved[0].blockWhenDisabled, true);
  assert.equal(saved[0].enabled, undefined, 'changing option must not silently enable/disable proxy');
  await elements.disable.click();
  assert.equal(saved.at(-1).enabled, false);
  assert.equal(saved.at(-1).blockWhenDisabled, true);
});
