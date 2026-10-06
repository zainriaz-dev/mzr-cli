import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, lstat, copyFile, chmod, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {validateReleaseTrust} from './trust.mjs';

export function platform(os = process.platform, arch = process.arch) {
  if (!['win32', 'linux', 'darwin'].includes(os) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported operating system or architecture');
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
export async function withInstallLock(root, action) {
  await privateDirectory(root);
  try { await lstat(path.join(root,'recovery.lock')); throw new Error('Installer recovery is active; retry after it finishes'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const filename = path.join(root, 'installer.lock');
  let lock;
  try { lock = await open(filename, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another installation is active, or an interrupted lock needs explicit recovery'); throw error; }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync(); return await action(); }
  finally { await lock.close(); await rm(filename, { force: true }); }
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
export async function download(url, destination, asset, config, accessToken,team='',fetcher=fetch) {
  if(team&&!/^[A-Za-z0-9_-]{1,64}$/.test(team))throw new Error('Invalid team identifier');
  checkAsset(asset);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !config.allowedDownloadOrigins.includes(parsed.origin)) throw new Error('Untrusted download origin');
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
  const headers = offset ? { Range: `bytes=${offset}-` } : {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if(team)headers['X-MZR-Team']=team;
  const response = await fetcher(url, { redirect: 'error', headers, signal: AbortSignal.timeout(120000) });
  if (response.status !== 200 && response.status !== 206) throw new Error('Private download unavailable; authorize again');
  if (response.status === 200) offset = 0;
  if (response.status === 206 && response.headers.get('content-range') !== `bytes ${offset}-${asset.size-1}/${asset.size}`) {
    await response.body?.cancel().catch(()=>{});throw new Error('Invalid resumed download range');
  }
  const declared=response.headers.get('content-length');
  if(declared!==null && (!/^\d+$/.test(declared)||Number(declared)!==asset.size-offset)) {
    await response.body?.cancel().catch(()=>{});throw new Error('Download length does not match signed size');
  }
  if(!response.body)throw new Error('Download response has no body');
  const file = await open(temporary, offset ? 'a' : 'w', 0o700);
  let length = offset;
  try { for await (const chunk of response.body) { length += chunk.length; if (length > asset.size) throw new Error('Download exceeded signed size'); await file.write(chunk); } await file.sync(); } finally { await file.close(); }
  if(length<asset.size)throw new Error('Download interrupted; bounded partial retained for explicit retry');
  if (!await validBinary(temporary, asset)) { await rm(temporary); throw new Error('Binary checksum verification failed'); }
  await rename(temporary, destination);
  return destination;
}
