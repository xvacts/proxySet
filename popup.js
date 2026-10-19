document.addEventListener('DOMContentLoaded', async () => {
  const schemeSelect = document.getElementById('scheme');
  const hostInput = document.getElementById('host');
  const portInput = document.getElementById('port');
  const noteInput = document.getElementById('note');
  const statusDiv = document.getElementById('status');
  const saveButton = document.getElementById('save');
  const disableButton = document.getElementById('disable');
  const blockInput = document.getElementById('blockWhenDisabled');
  let ready = false;
  let busy = true;

  function setBusy(value) {
    busy = value;
    saveButton.disabled = disableButton.disabled = blockInput.disabled = value;
  }
  setBusy(true);

  function updateDisableLabel() {
    disableButton.textContent = blockInput.checked ? '禁用代理并阻断网页联网' : '禁用代理（允许直连）';
  }

  function showError(error) {
    statusDiv.className = 'status disabled';
    statusDiv.textContent = `无法确认代理状态：${error.message}`;
  }

  async function refresh(action) {
    const result = await chrome.runtime.sendMessage({ action });
    if (!result?.success) throw new Error(result?.error || '后台未响应');
    statusDiv.className = result.enabled ? 'status enabled' : 'status disabled';
    // Render all stored/user supplied values as text, never HTML.
    statusDiv.textContent = result.enabled ?
      `✅ 浏览器代理配置已生效\n协议：${result.scheme.toUpperCase()}\n地址：${result.host}:${result.port}\n备注：${result.note || '这是翻墙节点'}\n此状态不代表代理服务器可用或全部流量受保护。` :
      result.blocked ? '⛔ 代理已禁用，网页联网已阻断（禁止新的网页网络请求）' :
      '❌ 代理已禁用（直连互联网）';
  }

  async function save(enabled) {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const settings = validateProxySettings({
        host: hostInput.value.trim(), port: portInput.value,
        scheme: schemeSelect.value, enabled
      });
      if (enabled) settings.note = noteInput.value.trim() || '这是翻墙节点';
      settings.blockWhenDisabled = blockInput.checked;
      await chrome.storage.local.set(settings);
      await refresh('applyProxy');
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  }

  saveButton.addEventListener('click', () => save(true));
  disableButton.addEventListener('click', () => save(false));
  blockInput.addEventListener('change', async () => {
    if (!ready || busy) return;
    updateDisableLabel();
    setBusy(true);
    try {
      await chrome.storage.local.set({ blockWhenDisabled: blockInput.checked });
      await refresh('applyProxy');
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  });
  try {
    const data = await chrome.storage.local.get(['host', 'port', 'scheme', 'note', 'blockWhenDisabled']);
    schemeSelect.value = data.scheme || 'socks5';
    hostInput.value = data.host || '192.168.100.1';
    portInput.value = data.port || 7896;
    noteInput.value = typeof data.note === 'string' ? data.note : '这是翻墙节点';
    blockInput.checked = data.blockWhenDisabled === true;
    updateDisableLabel();
    ready = true;
    await refresh('getStatus');
  } catch (error) { showError(error); }
  finally { setBusy(!ready); }
});
