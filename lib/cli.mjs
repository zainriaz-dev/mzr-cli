import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { deviceAuthorize,boundedJSON } from './device.mjs';
import { diagnose } from './doctor.mjs';
import {selectTeam} from './team.mjs';
import {networkOptions,createNetwork,retrying} from './network.mjs';
import { cacheRoot, platform, verifyManifest, validBinary, download, checkAsset, withInstallLock, saveState, importOffline, recoverInstallLock, purgeInstallerCache } from './install.mjs';

const config = JSON.parse(await readFile(new URL('../bootstrap-config.json', import.meta.url)));
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
const networkConfig=networkOptions(process.argv.slice(2));
const args = networkConfig.forwarded;
let network;
function secureFetch(url,init){network??=createNetwork(networkConfig);return network.fetch(url,init);}
function option(name,fallback){const index=args.indexOf(name);if(index<0)return fallback;if(!args[index+1]||args[index+1].startsWith('--'))throw new Error('Option requires a value');return args[index+1];}
const root = cacheRoot();
let selectedTeam=option('--team','');
if(selectedTeam&&!/^[A-Za-z0-9_-]{1,64}$/.test(selectedTeam))throw Error('Invalid team identifier');
const executableName = process.platform === 'win32' ? 'mzr.exe' : 'mzr';

// Ctrl+C, closing the terminal or a service stop must never leave the
// installer half-done or locked: the first signal cancels the work in flight,
// the lock is released by its finally block, and partial downloads are kept to
// resume. A second signal exits immediately.
const interrupt = new AbortController();
let child;
for (const name of ['SIGINT','SIGTERM','SIGHUP','SIGBREAK']) {
  try {
    process.on(name, () => {
      if (child) return; // The application handles its own signals.
      if (interrupt.signal.aborted) process.exit(130);
      interrupt.abort();
      console.error('\nStopping safely… (press Ctrl+C again to quit immediately)');
    });
  } catch {}
}

function help() { console.log('MZR Books private CLI launcher (run it as mzrbook or mzr; same program)\n\nmzr                       open MZR Books (installs it on first run)\nmzr update [--channel stable|beta] [--version VERSION]\n                            install a newer signed build; uses your app sign-in when possible\nmzr install [--no-browser] [--channel stable|beta] [--version VERSION]\nmzr install-offline --manifest ENVELOPE --binary FILE\nmzr rollback                return to the previous verified build\nmzr unlock --yes            recover an interrupted install (normally automatic)\nmzr uninstall [--purge-cache]\nmzr doctor [--offline]     check this machine, the installed build and the services (no sign-in)\n\nThe sign-in link and code are always printed, so you can approve on any device (servers and SSH included).\nOffline installation still requires a trusted signed artifact and does not grant membership. No postinstall authentication. Node 22+ required.'); }
// The API is a serverless function: the first call after a quiet period can
// take a while to start. Allow 45 s per attempt and retry busy or dropped
// requests a few times before reporting the precise cause.
async function api(endpoint, token, body) {
  return retrying(async () => {
    const response = await secureFetch(config.api + endpoint, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json','X-MZR-Contract-Version':'1','X-MZR-Client-Version':packageVersion,...(selectedTeam?{'X-MZR-Team':selectedTeam}:{}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([interrupt.signal, AbortSignal.timeout(45000)]) });
    if (response.status >= 500 || response.status === 429) { await response.body?.cancel().catch(()=>{}); throw Object.assign(new Error(`the MZR service is busy (HTTP ${response.status})`), {transient:true}); }
    const result = await boundedJSON(response);
    if (!response.ok || result.error) throw new Error(/^[a-z_]{1,80}$/.test(result.error?.code||'')?apiMessage(result.error.code):'Application access rejected');
    return result.data;
  }, {signal: interrupt.signal, onRetry: (error, attempt, delay) => console.error(`  ${error.message}; trying again in ${delay/1000}s…`)});
}
function apiMessage(code) {
  return {not_member:'this account is not a member of the MZR Books team yet; ask an administrator for an invitation',
    membership_required:'this account is not an active member of the MZR Books team; ask an administrator for an invitation',
    account_suspended:'this account is suspended; contact your administrator',account_revoked:"this account's access was revoked; contact your administrator",
    release_unavailable:'no signed release is available for this channel yet',sign_in_required:'the approval expired; run the command again'}[code] || code;
}
function headless() {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT) return 'connected over SSH';
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.WSL_DISTRO_NAME) return 'no graphical display';
  return '';
}
async function device() {
  const noBrowser = args.includes('--no-browser'), why = headless();
  return deviceAuthorize(config,{fetch:secureFetch,signal:interrupt.signal,print:()=>{},notice:line=>console.error('  '+line),open:uri=>{
    const code = new URL(uri).searchParams.get('user_code') || '';
    console.error(`\nTo approve this download, open this link in a browser on any device:\n\n  ${uri}\n\nand check the code matches: ${code}\n`);
    if (noBrowser || why) { if (why) console.error(`No browser was opened (${why}). This finishes by itself once you approve.`); }
    else {
      const opener=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',uri]]:process.platform==='darwin'?['open',[uri]]:['xdg-open',[uri]];
      const opened=spawn(opener[0],opener[1],{stdio:'ignore',windowsHide:true});opened.on('error',()=>{});opened.unref();
      console.error('Opened in your default browser. Wrong browser or profile? Copy the link above into the right one.');
    }
    console.error('Waiting for approval… (Ctrl+C cancels safely)');
  }});
}
function launch(filename, forwarded) {
  return new Promise(resolve => {
    child = spawn(filename, forwarded, {stdio:'inherit', windowsHide: false,
      env:{...process.env,MZR_OAUTH_CLIENT_ID:config.applicationClientId,MZR_API_URL:config.api,MZR_BOOTSTRAP_ROOT:root,...(selectedTeam?{MZR_TEAM_ID:selectedTeam}:{})}});
    child.on('error', () => { console.error('Unable to start verified client'); process.exitCode = 1; resolve(1); });
    child.on('exit', code => { process.exitCode = code ?? 1; resolve(code ?? 1); });
  });
}
async function readState() {
  try { return JSON.parse(await readFile(path.join(root, 'installation.json'))); } catch { return {}; }
}
// The installed, verified application binary, or null.
async function installedApp(state) {
  if (!state.current) return null;
  try {
    const manifest = verifyManifest(Buffer.from(state.current.manifest,'base64'),state.current.signature,state.current.keyId,config);
    const asset = manifest.assets[platform()]; checkAsset(asset);
    const filename = path.join(root,manifest.version,platform(),executableName);
    return await validBinary(filename,asset) ? {filename, version: manifest.version} : null;
  } catch { return null; }
}
function atLeast(version, minimum) {
  const a=version.split('-')[0].split('.').map(Number), b=minimum.split('.').map(Number);
  for (let i=0;i<3;i++) if (a[i]!==b[i]) return a[i]>b[i];
  return true;
}
// "mzr update" first asks the installed application (0.1.2+) to update itself
// with its existing sign-in, so no second browser approval is needed. It runs
// outside the installer lock, which the application takes itself. Returns
// true when that finished the job (or the person stopped it).
async function delegateUpdate() {
  if (args.includes('--version') || args.includes('--no-browser')) return false;
  const app = await installedApp(await readState());
  if (!app || !atLeast(app.version, '0.1.2')) return false;
  const channel = option('--channel', config.releaseChannel || 'stable');
  const code = await launch(app.filename, ['self-update', '--channel', channel]);
  child = undefined;
  if (code === 0 || code === 130) return true;
  if (code === 3) console.error('\nThe app is not signed in, so this update will ask for a quick browser approval instead.');
  else console.error('\nIn-app update did not finish; trying the launcher download instead.');
  process.exitCode = 0;
  return false;
}
async function main() {
  if (args[0] === '--bootstrap-help' || args[0] === 'bootstrap-help') return help();
  if(args[0]==='uninstall') {
    if(args.includes('--purge-cache'))await purgeInstallerCache(root);
    else await rm(path.join(root,'installation.json'),{force:true});
    console.log('Bootstrap cache unlinked. Application drafts, profiles and secure credential store retained.');return;
  }
  if (!config.configured || !config.clientId || !config.applicationClientId || !Object.keys(config.publicKeys).length) { help(); throw new Error('Release gates incomplete: OAuth clients, signing root and private artifacts must be configured before publication'); }
  await mkdir(root, {recursive:true,mode:0o700});
  const statePath = path.join(root, 'installation.json');
  const state = await readState();
  if(!selectedTeam && /^[A-Za-z0-9_-]{1,64}$/.test(state.team||''))selectedTeam=state.team;
  if (args[0] === 'rollback') {if (!state.previous) throw new Error('No verified prior version');const old = verifyManifest(Buffer.from(state.previous.manifest,'base64'),state.previous.signature,state.previous.keyId,config);const asset=old.assets[platform()];checkAsset(asset);if(!await validBinary(path.join(root,old.version,platform(),executableName),asset))throw new Error('Rollback artifact failed verification');[state.current,state.previous]=[state.previous,state.current];await saveState(statePath,state);console.log(`Rolled back to verified MZR Books ${old.version}.`);return;}
  const key = platform();
  if (args[0] === 'install-offline') {
    const envelopePath=option('--manifest',null), binary=option('--binary',null);
    if(!envelopePath||!binary)throw new Error('A signed manifest envelope and binary are required');
    const envelopeBytes=await readFile(envelopePath);if(envelopeBytes.length>2*1024*1024)throw new Error('Offline envelope too large');
    const envelope=JSON.parse(envelopeBytes);const manifest=verifyManifest(Buffer.from(envelope.manifest,'base64'),envelope.signature,envelope.keyId,config);
    const asset=manifest.assets[key];checkAsset(asset);const filename=path.join(root,manifest.version,key,executableName);
    await importOffline(binary,filename,asset);await saveState(statePath,{current:envelope,previous:state.current,team:selectedTeam});
    console.log('Verified offline artifact installed. This does not grant application membership or online access.');return;
  }
  if (!['install','update'].includes(args[0])) {
    const app = await installedApp(state);
    if (app) return {launch: app.filename};
  }
  const access = await device(); // Bootstrap authorization never persisted to disk.
  selectedTeam=selectTeam(await api('/v1/teams',access),selectedTeam);
  const channel=option('--channel',config.releaseChannel||'stable');
  if(!['stable','beta'].includes(channel))throw new Error('Unknown release channel');
  const params=new URLSearchParams({channel});const pinned=option('--version',null);if(pinned)params.set('version',pinned);
  const release = await api('/v1/releases?'+params,access);
  const bytes = Buffer.from(release.manifest,'base64');
  const manifest = verifyManifest(bytes,release.signature,release.key_id,config);
  const asset = manifest.assets[key]; checkAsset(asset);
  const entitlement = await api('/v1/downloads',access,{version:manifest.version,platform:key});
  const filename = path.join(root,manifest.version,key,executableName);
  if (!await validBinary(filename,asset)) {
    let shown=-1;
    // Each retry resumes the kept partial file from where the connection dropped.
    await retrying(() => download(entitlement.url,filename,asset,config,access,selectedTeam,secureFetch,{signal:interrupt.signal,progress:(done,total)=>{
      const pct=Math.floor(done*100/total);if(Math.floor(pct/5)!==Math.floor(shown/5)&&process.stderr.isTTY){shown=pct;process.stderr.write(`\r  Downloading ${String(pct).padStart(3)}%  ${(done/1048576).toFixed(1)} of ${(total/1048576).toFixed(1)} MB`);}
    }}), {attempts: 5, signal: interrupt.signal, onRetry: (error, attempt, delay) => {
      if(shown>=0)process.stderr.write('\n');
      console.error(`  ${error.message}; resuming in ${delay/1000}s…`);
    }});
    if(shown>=0)process.stderr.write('\n');
  }
  const current = {manifest:release.manifest,signature:release.signature,keyId:release.key_id};
  await saveState(statePath,{current,previous:state.current,team:selectedTeam});
  console.log(`Verified MZR Books ${manifest.version} installed.`);
  if (!['install','update'].includes(args[0])) return {launch: filename};
}
// Read-only health check; needs no sign-in and never changes anything.
async function runDoctor() {
  let platformKey;
  try { platformKey = platform(); } catch { platformKey = process.platform + '-' + process.arch; }
  const checks = await diagnose({config, root, platformKey, installed: await installedApp(await readState()), fetch: secureFetch, offline: args.includes('--offline'), signal: interrupt.signal});
  for (const check of checks) console.log((check.ok ? '✓' : '✗') + ' ' + check.name + ': ' + check.detail);
  const failed = checks.filter(check => !check.ok).length;
  console.log(failed ? `\n${failed} problem(s) found. Run mzrbook again after fixing them, or share this output with your administrator.` : '\nEverything looks good.');
  if (failed) process.exitCode = 1;
}
async function entry() {
  if (args[0] === 'doctor') return runDoctor();
  if (args[0] === 'unlock') return recoverInstallLock(root,args.includes('--yes'));
  if (args[0] === '--bootstrap-help' || args[0] === 'bootstrap-help') return help();
  if (args[0] === 'update' && config.configured && await delegateUpdate()) return;
  // The lock covers only installation work, never the running application.
  const result = await withInstallLock(root, main);
  if (result?.launch) await launch(result.launch, args);
}
entry().catch(error => {
  if (interrupt.signal.aborted) {
    console.error('Stopped. Nothing unverified was installed; any partial download is kept and resumes when you run the command again.');
    process.exitCode = 130;
  } else {
    console.error('MZR bootstrap failed safely: '+error.message+'. No unverified executable was launched.');
    if (error.transient) console.error('Nothing was changed. Run the same command again when the connection is steady; any partial download resumes where it stopped.');
    process.exitCode = process.exitCode || 1;
  }
}).finally(async()=>{await network?.close();});
