import { createHash, createPublicKey, verify, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, lstat, copyFile, chmod, readdir, utimes } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import {validateReleaseTrust} from './trust.mjs';

export function platform(os = process.platform, arch = process.arch) {
  if (!['win32', 'linux', 'darwin'].includes(os) || !['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported operating system or architecture (${os} ${arch}); supported: Windows, Linux and macOS on x64 or arm64`);
  return `${os}-${arch}`;
}
export function cacheRoot() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'MZRBooks');
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'mzr-books');
  return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'mzr-books');
}
export function verifyManifest(bytes, signature, keyId, config) {
  if (bytes.length > 1024 * 1024) throw new Error('Manifest exceeds size limit');
  const key = config.publicKeys[keyId];
  if (!key) throw new Error('Release verification key not trusted');
  validateReleaseTrust(keyId,config.keyPolicies,null,config.configured===true);
  const trustedKey=createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
  if(trustedKey.asymmetricKeyType!=='ed25519')throw new Error('Release root must be Ed25519');
  if (!verify(null, bytes, trustedKey, Buffer.from(signature, 'base64'))) throw new Error('Release manifest signature rejected');
  const manifest = JSON.parse(bytes.toString('utf8'));
  validateReleaseTrust(keyId,config.keyPolicies,manifest,config.configured===true);
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('Invalid release version');
  if (!Number.isFinite(Date.parse(manifest.expiresAt)) || Date.parse(manifest.expiresAt) < Date.now()) throw new Error('Release manifest expired');
  return manifest;
}
export function checkAsset(asset) {
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 100 * 1024 * 1024) throw new Error('Invalid release asset');
  if (asset.format !== 'binary') throw new Error('Only raw binaries are supported; archive extraction is deliberately disabled');
}
export async function validBinary(filename, asset) {
  try { const metadata = await lstat(filename); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== asset.size) return false; return createHash('sha256').update(await readFile(filename)).digest('hex') === asset.sha256; } catch { return false; }
}
export async function privateDirectory(directory) {
  const resolved = path.resolve(directory);
  // Refuse symlinked components instead of following them during installation.
  for (let parent = resolved;; parent = path.dirname(parent)) {
    try { const metadata = await lstat(parent); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Unsafe installer directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(parent) === parent) break;
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}
// The lock record names its owner process, host and a random token, and a
// heartbeat refreshes its timestamp. A lock left by an interrupted run (Ctrl+C,
// closed window, crash, power loss) is recovered automatically when its owner
// is gone on this host, its record was never written, or its heartbeat stopped
// long ago. A live installer is never interrupted. Shared with the Go client
// (client/internal/update/install.go), which uses the same rules.
export const LOCK_HEARTBEAT_MS = 10000;
export const LOCK_STALE_MS = 120000;
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return error.code === 'EPERM'; }
}
export async function staleLock(filename, alive = processAlive, now = Date.now()) {
  let metadata;
  try { metadata = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (!metadata.isFile() || metadata.size > 4096) return false;
  const age = now - metadata.mtimeMs;
  let record;
  try { record = JSON.parse(await readFile(filename, 'utf8')); } catch { return age > 30000; }
  if (!Number.isSafeInteger(record?.pid) || record.pid < 1) return age > 30000;
  if (record.host === hostname() && !alive(record.pid)) return true;
  // Records from 0.1.x launchers have no host: on this machine a dead PID is
  // still conclusive, and a stopped heartbeat frees it either way.
  if (!record.host && !alive(record.pid)) return true;
  return age > LOCK_STALE_MS;
}
async function reclaim(filename, alive) {
  if (!await staleLock(filename, alive)) return false;
  // Move aside atomically so two recovering processes cannot both win.
  const aside = `${filename}.stale-${randomBytes(4).toString('hex')}`;
  try { await rename(filename, aside); } catch (error) { if (error.code === 'ENOENT') return true; return false; }
  await rm(aside, { force: true });
  return true;
}
export async function withInstallLock(root, action, alive = processAlive) {
  await privateDirectory(root);
  try { await lstat(path.join(root,'recovery.lock')); throw new Error('Installer recovery is active; retry after it finishes'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const filename = path.join(root, 'installer.lock');
  const token = randomBytes(16).toString('hex');
  let lock;
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await open(filename, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && await reclaim(filename, alive)) continue;
      throw new Error('Another MZR installation is running right now; it will finish, or be recovered automatically if it was interrupted');
    }
  }
  const beat = setInterval(() => { const t = new Date(); utimes(filename, t, t).catch(() => {}); }, LOCK_HEARTBEAT_MS);
  beat.unref();
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token, tool: 'npm-launcher', startedAt: new Date().toISOString() })); await lock.sync(); return await action(); }
  finally {
    clearInterval(beat);
    await lock.close();
    // Only remove the lock if it is still ours (never another process's).
    try { if (JSON.parse(await readFile(filename, 'utf8')).token === token) await rm(filename, { force: true }); } catch {}
  }
}
export async function recoverInstallLock(root, confirmed, alive = pid => { try { process.kill(pid,0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }) {
  if (!confirmed) throw new Error('Explicit confirmation required to recover an interrupted installer');
  await privateDirectory(root);
  const recovering=path.join(root,'recovery.lock');const guard=await open(recovering,'wx',0o600);
  try {
    await guard.writeFile(JSON.stringify({pid:process.pid}));await guard.sync();
    const filename=path.join(root,'installer.lock');const metadata=await lstat(filename);
    if(!metadata.isFile()||metadata.size>4096)throw new Error('Unsafe installation lock');
    let record;try{record=JSON.parse(await readFile(filename,'utf8'));}catch{throw new Error('Incomplete lock requires manual owner inspection; not automatically removed');}
    if(!Number.isSafeInteger(record.pid)||record.pid<1||alive(record.pid))throw new Error('Live or unknown installer must not be interrupted');
    await rm(filename);return true;
  } finally {await guard.close();await rm(recovering,{force:true});}
}
export async function saveState(filename, state) {
  await privateDirectory(path.dirname(filename));
  try { const metadata = await lstat(filename); if (!metadata.isFile()) throw new Error('Unsafe installation state'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${filename}.${process.pid}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, filename); } finally { await rm(temporary, { force: true }); }
}
export async function purgeInstallerCache(root) {
  const resolved=path.resolve(root);
  if(!['MZRBooks','mzr-books'].includes(path.basename(resolved)))throw Error('Unexpected installer cache target');
  await privateDirectory(resolved);
  const targets=[];
  for(const entry of await readdir(resolved,{withFileTypes:true})) {
    if(['installer.lock','recovery.lock'].includes(entry.name))continue;
    if(entry.name!=='installation.json'&&!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(entry.name))throw Error('Unexpected cache content; owner inspection required before purge');
    const target=path.resolve(resolved,entry.name);
    if(path.dirname(target)!==resolved)throw Error('Unsafe cache target');
    const check=async filename=>{
      const metadata=await lstat(filename);
      if(metadata.isSymbolicLink()||!metadata.isFile()&&!metadata.isDirectory())throw Error('Unsafe cache entry');
      if(metadata.isDirectory())for(const child of await readdir(filename))await check(path.join(filename,child));
    };
    await check(target);targets.push(target);
  }
  // All targets are validated inside this exact installer cache before deletion.
  // The lock/root and separate application drafts/profiles/vault stay intact.
  for(const target of targets)await rm(target,{recursive:true,force:true});
}
export async function importOffline(filename, destination, asset) {
  checkAsset(asset);
  if (!await validBinary(filename, asset)) throw new Error('Offline artifact checksum rejected');
  await privateDirectory(path.dirname(destination));
  const temporary = destination + '.offline.partial';
  // COPYFILE_EXCL prevents overwriting an unexpected pre-existing path.
  await copyFile(filename, temporary, 1);
  try { await chmod(temporary, 0o700); if (!await validBinary(temporary, asset)) throw new Error('Offline copy changed during import'); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
  return destination;
}
// A download may take minutes on a slow link, so there is no total deadline;
// instead it fails after STALL_MS without progress. Ctrl+C (options.signal)
// stops it cleanly and keeps the verified-size partial file for resuming.
export const STALL_MS = 60000;
// Only HTTPS links on pinned hosts are followed: the authenticated gateway origins, or,
// for signed links, the pinned storage origin and bucket path.
export function checkLink(link, config) {
  const parsed = new URL(link.url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname.includes('..')) throw new Error('Untrusted download origin');
  if (link.signed) {
    const pinned = config.signedDownloads;
    if (!pinned || parsed.origin !== pinned.origin || !parsed.pathname.startsWith(pinned.pathPrefix)) throw new Error('Untrusted download origin');
  } else if (!config.allowedDownloadOrigins.includes(parsed.origin)) throw new Error('Untrusted download origin');
}
// source: a gateway URL string, or an async function returning {url, signed} that is asked
// again before every request so a resume never reuses an expired link.
export async function download(source, destination, asset, config, accessToken,team='',fetcher=fetch,options={}) {
  if(team&&!/^[A-Za-z0-9_-]{1,64}$/.test(team))throw new Error('Invalid team identifier');
  checkAsset(asset);
  if (typeof source === 'string') checkLink({url: source, signed: false}, config);
  await privateDirectory(path.dirname(destination));
  const temporary = destination + '.partial';
  // Resume only a bounded partial download; the complete hash is always checked.
  let offset = 0;
  try { const metadata = await lstat(temporary); if (!metadata.isFile()) throw new Error('Unsafe partial download'); offset = metadata.size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (offset > asset.size) { await rm(temporary); offset = 0; }
  if(offset===asset.size) {
    if(await validBinary(temporary,asset)){await rename(temporary,destination);return destination;}
    await rm(temporary);offset=0;
  }
  const base = {};
  if (accessToken) base.Authorization = `Bearer ${accessToken}`;
  if(team)base['X-MZR-Team']=team;
  const stall = new AbortController();
  let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(new Error('Download stalled')), options.stallMs ?? STALL_MS); timer.unref?.(); };
  touch();
  const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
  try {
    // The storage service ends each range reply after one window (10 MiB), so a resumed
    // download is a series of ranges, each starting exactly where the file ends.
    do { const before = offset; offset = await receive(); if (offset <= before && offset < asset.size) throw new Error('Download interrupted; the partial file is kept and resumes next time'); } while (offset < asset.size);
    if (!await validBinary(temporary, asset)) { await rm(temporary); throw new Error('Binary checksum verification failed'); }
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    if (options.signal?.aborted) throw Object.assign(new Error('Download paused; the partial file is kept and resumes next time'), { code: 'ABORT_ERR' });
    if (stall.signal.aborted) throw Object.assign(new Error('Download stalled without progress; run the update again to resume'), { transient: true });
    // A connection dropped mid-transfer keeps the partial file, so another
    // attempt resumes it. Integrity and authorization failures never retry.
    if (error.transient === undefined && !/checksum|exceeded|does not match|Invalid resumed|Untrusted|unavailable|no body/.test(error.message)) error.transient = true;
    throw error;
  } finally { clearTimeout(timer); }
  async function receive() {
  const link = typeof source === 'function' ? await source() : {url: source, signed: false};
  checkLink(link, config);
  // A signed link carries its own signature; Google rejects a request that also sends credentials.
  const headers = { ...(link.signed ? {} : base), ...(offset ? { Range: `bytes=${offset}-` } : {}) };
  const response = await fetcher(link.url, { redirect: 'error', headers, signal });
  if (response.status !== 200 && response.status !== 206) throw new Error('Private download unavailable; authorize again');
  let last = asset.size - 1;
  if (response.status === 200) offset = 0;
  else {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== offset || Number(range[3]) !== asset.size || Number(range[2]) < offset || Number(range[2]) > asset.size - 1) {
      await response.body?.cancel().catch(()=>{});throw new Error('Invalid resumed download range');
    }
    last = Number(range[2]);
  }
  const declared=response.headers.get('content-length');
  if(declared!==null && (!/^\d+$/.test(declared)||Number(declared)!==last+1-offset)) {
    await response.body?.cancel().catch(()=>{});throw new Error('Download length does not match signed size');
  }
  if(!response.body)throw new Error('Download response has no body');
  const file = await open(temporary, offset ? 'a' : 'w', 0o700);
  let length = offset;
  try { for await (const chunk of response.body) { touch(); length += chunk.length; if (length > last + 1) throw new Error('Download exceeded signed size'); await file.write(chunk); options.progress?.(length, asset.size); } await file.sync(); } finally { await file.close(); }
  return length;
  }
}

