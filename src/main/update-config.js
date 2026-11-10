import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://download.carl.top/api/v1/apps/monitor/';
const readToken = () => {
  if (process.env.MONITOR_TOOL_UPDATE_TOKEN) return process.env.MONITOR_TOOL_UPDATE_TOKEN;
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'update-channel.local.json')] : []),
    fileURLToPath(new URL('../../update-channel.local.json', import.meta.url))
  ];
  for (const filePath of candidates) {
    try {
      const config = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof config.token === 'string' && config.token.trim()) return config.token.trim();
    } catch { /* Developers can build the monitor without an update channel. */ }
  }
  return '';
};
const API_TOKEN = readToken();

// Keep authenticated endpoint URLs in the main process, out of renderer state
// and error messages. The token can be rotated through the environment/build.
export function updateEndpoint(action, version) {
  if (!['latest', 'check', 'download'].includes(action)) throw new Error('无效的更新操作');
  if (!API_TOKEN) throw Object.assign(new Error('Update channel not configured'), { userMessage: '更新通道尚未配置，请手动从 GitHub 获取版本' });
  const url = new URL(action, API_ROOT);
  url.searchParams.set('platform', 'windows');
  url.searchParams.set('token', API_TOKEN);
  if (action === 'check') url.searchParams.set('version', version);
  return url.href;
}

export function updateErrorCode(error) {
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return 'TIMEOUT';
  const candidates = [error?.code, error?.cause?.code];
  for (const code of candidates) if (/^(ERR_[A-Z_]+|E[A-Z_]+|UND_ERR_[A-Z_]+|HTTP_\d{3})$/.test(String(code ?? ''))) return String(code);
  const chromium = String(error?.message ?? '').match(/net::(ERR_[A-Z_]+)/);
  if (chromium) return chromium[1];
  if (/fetch failed|failed to fetch|network|connection/i.test(String(error?.message ?? ''))) return 'NETWORK_ERROR';
  return error?.userMessage ? 'UPDATE_ERROR' : 'CLIENT_ERROR';
}

export function redactUpdateText(value) {
  let text = String(value ?? '');
  if (API_TOKEN) text = text.replaceAll(API_TOKEN, '[redacted]');
  return text.replace(/https?:\/\/[^\s"'<>()[\]]+/g, (value) => {
    try {
      const url = new URL(value);
      return url.origin + url.pathname + (url.search ? '?[redacted]' : '');
    } catch { return '[redacted-url]'; }
  });
}

export function safeUpdateError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '连接超时或操作已取消，请稍后重试';
  if (error?.userMessage) return error.userMessage;
  if (error?.code === 'ENOSPC') return '磁盘空间不足，无法保存更新包，请清理空间或手动下载';
  if (['EACCES', 'EPERM'].includes(error?.code)) return '无法访问更新缓存目录，请选择手动下载';
  const code = updateErrorCode(error);
  if (/PROXY|TUNNEL/.test(code)) return `系统代理连接失败（${code}），请确认代理已就绪后重试`;
  if (/CERT|TLS|SSL/.test(code)) return `更新站点的安全连接未建立（${code}），请稍后重试或手动下载`;
  if (code === 'ERR_BLOCKED_BY_CLIENT') return '更新地址或跳转未通过安全检查，已停止下载，请联系作者';
  if (['CLIENT_ERROR', 'ERR_INVALID_ARG_TYPE'].includes(code)) return `更新过程遇到客户端异常（${code}），可选择手动下载`;
  return `更新服务暂时无法连接（${code}），请重试或选择手动下载`;
}
