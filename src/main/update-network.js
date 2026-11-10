import { session } from 'electron';

// Electron net.fetch rejects manual redirects before returning a Response.
// Let Chromium follow them in an isolated session, and enforce HTTPS and a
// bounded redirect chain through webRequest instead of cancelling each hop.
export function createUpdateFetcher() {
  const updateSession = session.fromPartition('monitor-tool-updates', { cache: false });
  const redirects = new Map();
  updateSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = url.protocol === 'https:' && !url.username && !url.password && (redirects.get(details.id) ?? 0) <= 5;
    } catch { /* Reject an invalid update URL. */ }
    callback({ cancel: !allowed });
  });
  updateSession.webRequest.onBeforeRedirect((details) => redirects.set(details.id, (redirects.get(details.id) ?? 0) + 1));
  updateSession.webRequest.onCompleted((details) => redirects.delete(details.id));
  updateSession.webRequest.onErrorOccurred((details) => redirects.delete(details.id));
  return (url, options) => updateSession.fetch(url, { ...options, redirect: 'follow' });
}
