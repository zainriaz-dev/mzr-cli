// Where each download attempt reads from.
//
// The launcher asks the pinned link service for a short-lived signed Google Cloud
// Storage link. The sign-in token goes only to that pinned service; the link it
// returns is used without any credentials. A release the service does not host, or
// a service that cannot be reached, falls back to the older authenticated gateway.
// A refusal because of who you are is final: no fallback, no retry.

const LINK_TIMEOUT_MS = 60000;

function refused(status) {
  return Object.assign(new Error(`Private download refused (HTTP ${status}); sign in again or check team access`), { transient: false, refused: true });
}

export function releaseLinks({ config, version, platform, access, team = '', fetch: fetcher = fetch, signal, legacy }) {
  return async function nextLink() {
    if (config.linkService) {
      const base = new URL(config.linkService);
      if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Link service is not configured safely');
      try {
        const response = await fetcher(`${base.origin}/v1/links/${encodeURIComponent(version)}/${encodeURIComponent(platform)}`, {
          redirect: 'error',
          headers: { Authorization: `Bearer ${access}`, 'X-MZR-Contract-Version': '1', ...(team ? { 'X-MZR-Team': team } : {}) },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(LINK_TIMEOUT_MS)]) : AbortSignal.timeout(LINK_TIMEOUT_MS),
        });
        if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => {}); throw refused(response.status); }
        if (response.ok) {
          const text = await response.text();
          if (text.length <= 16384) {
            const body = JSON.parse(text);
            if (typeof body.url === 'string' && body.url) return { url: body.url, signed: true };
          }
        } else await response.body?.cancel().catch(() => {});
      } catch (error) {
        if (error.refused || signal?.aborted) throw error;
        // Not hosted there yet, or unreachable: use the older route below.
      }
    }
    const url = await legacy();
    if (typeof url !== 'string' || !url) throw Object.assign(new Error('This release is not available for download yet; try again shortly'), { transient: false });
    return { url, signed: false };
  };
}
