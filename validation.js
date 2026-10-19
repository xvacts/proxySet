// Shared validation: accept a host, never a URL or credentials.
function validateProxySettings({ host, port, scheme, enabled }) {
  if (typeof enabled !== 'boolean') throw new Error('启用状态无效');
  if (!enabled) return { enabled: false };
  if (!['socks5', 'http'].includes(scheme)) throw new Error('代理协议无效');
  if (typeof host !== 'string' || !host || host !== host.trim() || host.length > 253) {
    throw new Error('代理地址无效');
  }
  if (host.includes(':')) {
    const literal = host.startsWith('[') ? host : `[${host}]`;
    if (!/^\[[0-9a-fA-F:.]+\]$/.test(literal)) throw new Error('IPv6 地址无效');
    try { new URL(`http://${literal}/`); }
    catch { throw new Error('IPv6 地址无效'); }
  } else {
    const name = host.endsWith('.') ? host.slice(0, -1) : host;
    if (!name.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
      throw new Error('请输入 IP 或 ASCII 域名，不要包含协议、路径或凭据');
    }
    if (/^[0-9.]+$/.test(name) && !(/^\d+\.\d+\.\d+\.\d+$/.test(name) && name.split('.').every(n => Number(n) <= 255))) {
      throw new Error('IPv4 地址无效');
    }
  }
  const numericPort = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error('端口必须是 1–65535 的整数');
  }
  return { host, port: numericPort, scheme, enabled: true };
}
