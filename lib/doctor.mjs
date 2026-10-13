// `mzrbook doctor`: a read-only health check that needs no sign-in. It reports
// the machine, the installed build and whether the services answer, and never
// changes anything or sends credentials.
import { access, constants, lstat } from 'node:fs/promises';
import path from 'node:path';
import { runtimeProblem, SUPPORTED } from './runtime.mjs';
import { staleLock } from './install.mjs';

const PROXY_VARIABLES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];

async function reachable(fetcher, url, expected, signal) {
  try {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    await response.body?.cancel().catch(() => {});
    return expected.includes(response.status) ? { ok: true, detail: `answered (HTTP ${response.status})` } : { ok: false, detail: `unexpected answer (HTTP ${response.status})` };
  } catch (error) {
    return { ok: false, detail: `no answer (${error.cause?.code || error.name || 'network error'})` };
  }
}

export async function diagnose({ config, root, platformKey, installed, fetch: fetcher, offline = false, env = process.env, signal = new AbortController().signal }) {
  const checks = [];
  const add = (name, result) => checks.push({ name, ...result });
  const problem = runtimeProblem();
  add('Node.js and machine', problem ? { ok: false, detail: problem } : { ok: true, detail: `Node.js ${process.versions.node} on ${platformKey}` });
  add('Release channel', { ok: config.configured === true, detail: config.configured === true ? `${config.releaseChannel} (signed releases are enabled)` : 'this launcher build is not enabled for releases yet' });
  add('Release signing keys', { ok: Object.keys(config.publicKeys || {}).length > 0, detail: `${Object.keys(config.publicKeys || {}).join(', ') || 'none'} pinned in this launcher` });
  // The install folder is created on first use, so test the nearest folder that exists.
  let parent = path.dirname(root);
  for (;;) {
    try { await access(parent, constants.F_OK); break; } catch { if (path.dirname(parent) === parent) break; parent = path.dirname(parent); }
  }
  try { await access(parent, constants.W_OK); add('Install location', { ok: true, detail: root }); }
  catch { add('Install location', { ok: false, detail: `${parent} is not writable` }); }
  if (installed) add('Installed MZR Books', { ok: true, detail: `${installed.version} (signature and SHA-256 verified)` });
  else add('Installed MZR Books', { ok: true, detail: 'not installed yet; the first run downloads and verifies it after you sign in' });
  try {
    const lock = path.join(root, 'installer.lock');
    await lstat(lock);
    const stale = await staleLock(lock);
    add('Installer lock', { ok: stale, detail: stale ? 'a leftover lock from an interrupted run; it clears itself on the next run' : 'another installation is running right now' });
  } catch (error) { if (error.code !== 'ENOENT') add('Installer lock', { ok: false, detail: error.message }); }
  const proxies = PROXY_VARIABLES.filter(name => env[name]);
  add('Proxy', { ok: true, detail: proxies.length ? `${proxies.join(', ')} set (used only with --bootstrap-proxy-env)` : 'none (direct connection)' });
  if (offline) add('Network checks', { ok: true, detail: 'skipped (--offline)' });
  else {
    // Unauthenticated probes: a 401 proves the service is up and refuses strangers.
    const issuer = await reachable(fetcher, config.issuer + '/.well-known/openid-configuration', [200], signal);
    add('Sign-in service', issuer);
    const api = await reachable(fetcher, config.api + '/v1/releases', [401, 403], signal);
    add('MZR API', api.ok ? { ok: true, detail: 'online and refusing unsigned requests (HTTP 401)' } : api);
    if (config.linkService) {
      const links = await reachable(fetcher, new URL(config.linkService).origin + '/v1/links/0.0.0/win32-x64', [401], signal);
      add('Download link service', links.ok ? { ok: true, detail: 'online and refusing requests without a sign-in (HTTP 401)' } : links);
    }
    add('Download gateway', await reachable(fetcher, new URL(config.allowedDownloadOrigins.find(o => !o.includes('appwrite.io')) || config.allowedDownloadOrigins[0]).origin + '/', [200, 401, 403, 404], signal));
  }
  return checks;
}
export { SUPPORTED };
