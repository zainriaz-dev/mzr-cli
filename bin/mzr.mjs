#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { deviceAuthorize,boundedJSON } from '../lib/device.mjs';
import {selectTeam} from '../lib/team.mjs';
import {networkOptions,createNetwork} from '../lib/network.mjs';
import { cacheRoot, platform, verifyManifest, validBinary, download, checkAsset, withInstallLock, saveState, importOffline, recoverInstallLock, purgeInstallerCache } from '../lib/install.mjs';

const config = JSON.parse(await readFile(new URL('../bootstrap-config.json', import.meta.url)));
const networkConfig=networkOptions(process.argv.slice(2));
const args = networkConfig.forwarded;
let network;
function secureFetch(url,init){network??=createNetwork(networkConfig);return network.fetch(url,init);}
function option(name,fallback){const index=args.indexOf(name);if(index<0)return fallback;if(!args[index+1]||args[index+1].startsWith('--'))throw new Error('Option requires a value');return args[index+1];}
const root = cacheRoot();
let selectedTeam=option('--team','');
if(selectedTeam&&!/^[A-Za-z0-9_-]{1,64}$/.test(selectedTeam))throw Error('Invalid team identifier');
const executableName = process.platform === 'win32' ? 'mzr.exe' : 'mzr';
function help() { console.log('MZR Books private CLI bootstrap\n\nmzr install [--no-browser] [--channel stable|beta] [--version VERSION]\nmzr update [--channel stable|beta] [--version VERSION]\nmzr install-offline --manifest ENVELOPE --binary FILE\nmzr rollback\nmzr unlock --yes\nmzr uninstall [--purge-cache]\n\nOffline installation still requires a trusted signed artifact and does not grant membership. Unlock refuses a live installer. No postinstall authentication. Node 22+ required. Release is not published until configured.'); }
async function api(endpoint, token, body) {
  const response = await secureFetch(config.api + endpoint, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json','X-MZR-Contract-Version':'1','X-MZR-Client-Version':'0.1.0',...(selectedTeam?{'X-MZR-Team':selectedTeam}:{}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  const result = await boundedJSON(response);
  if (!response.ok || result.error) throw new Error(/^[a-z_]{1,80}$/.test(result.error?.code||'')?result.error.code:'Application access rejected');
  return result.data;
}
async function device() {
  return deviceAuthorize(config,{fetch:secureFetch,print:line=>console.error(line),open:uri=>{
    if(args.includes('--no-browser') || process.env.SSH_CONNECTION)return;
    const opener=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',uri]]:process.platform==='darwin'?['open',[uri]]:['xdg-open',[uri]];
    const child=spawn(opener[0],opener[1],{stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
  }});
}
async function launch(filename, forwarded) {
  const child = spawn(filename, forwarded, {stdio:'inherit', windowsHide: false,
    env:{...process.env,MZR_OAUTH_CLIENT_ID:config.applicationClientId,MZR_API_URL:config.api,...(selectedTeam?{MZR_TEAM_ID:selectedTeam}:{})}});
  child.on('error', () => { console.error('Unable to start verified client'); process.exitCode = 1; });
  child.on('exit', code => {process.exitCode = code || 0;});
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
  let state = {}; try {state = JSON.parse(await readFile(statePath));} catch {}
  if(!selectedTeam && /^[A-Za-z0-9_-]{1,64}$/.test(state.team||''))selectedTeam=state.team;
  if (args[0] === 'rollback') {if (!state.previous) throw new Error('No verified prior version');const old = verifyManifest(Buffer.from(state.previous.manifest,'base64'),state.previous.signature,state.previous.keyId,config);const asset=old.assets[platform()];checkAsset(asset);if(!await validBinary(path.join(root,old.version,platform(),executableName),asset))throw new Error('Rollback artifact failed verification');[state.current,state.previous]=[state.previous,state.current];await saveState(statePath,state);return;}
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
  if (!['install','update'].includes(args[0]) && state.current) {
    const manifest = verifyManifest(Buffer.from(state.current.manifest,'base64'),state.current.signature,state.current.keyId,config);
    const asset = manifest.assets[key]; checkAsset(asset);
    const filename = path.join(root,manifest.version,key,executableName);
    if (await validBinary(filename,asset)) return launch(filename,args);
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
  if (!await validBinary(filename,asset)) await download(entitlement.url,filename,asset,config,access,selectedTeam,secureFetch);
  const current = {manifest:release.manifest,signature:release.signature,keyId:release.key_id};
  await saveState(statePath,{current,previous:state.current,team:selectedTeam});
  console.log(`Verified MZR Books ${manifest.version} installed.`);
  if (!['install','update'].includes(args[0])) return launch(filename,args);
}
// Hold the installation lock only while bootstrap work runs, not while the Go
// application is alive. A crash lock is never silently stolen.
(args[0] === 'unlock' ? recoverInstallLock(root,args.includes('--yes')) : args[0] === '--bootstrap-help' || args[0] === 'bootstrap-help' ? main() : withInstallLock(root,main)).catch(error => {console.error('MZR bootstrap failed safely: '+error.message+'. No unverified executable was launched.');process.exitCode=1;}).finally(async()=>{await network?.close();});
