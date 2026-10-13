import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {importOffline,withInstallLock,saveState,recoverInstallLock} from '../lib/install.mjs';

// macOS aliases /var to /private/var. Resolve the test-owned temporary root;
// production's refusal to install through symlink ancestors remains intact.
async function temporary(prefix){return realpath(await mkdtemp(path.join(await realpath(tmpdir()),prefix)));}

test('offline import accepts only verified artifacts and preserves prior binary',async()=>{
 const root=await temporary('mzr-offline-');const bytes=Buffer.from('synthetic binary');const source=path.join(root,'source');const target=path.join(root,'cache','mzr');
 const asset={size:bytes.length,format:'binary',sha256:createHash('sha256').update(bytes).digest('hex')};
 try{await writeFile(source,bytes);await importOffline(source,target,asset);assert.deepEqual(await readFile(target),bytes);await writeFile(source,Buffer.alloc(bytes.length));await assert.rejects(importOffline(source,target,asset),/checksum/);assert.deepEqual(await readFile(target),bytes);}finally{await rm(root,{recursive:true,force:true});}
});
test('explicit recovery refuses live installer and recovers a stopped one',async()=>{
 const root=await temporary('mzr-recovery-');try{await writeFile(path.join(root,'installer.lock'),JSON.stringify({pid:12345}));await assert.rejects(recoverInstallLock(root,false,()=>false),/confirmation/);await assert.rejects(recoverInstallLock(root,true,()=>true),/Live/);assert.equal(await recoverInstallLock(root,true,()=>false),true);await withInstallLock(root,async()=>{});}finally{await rm(root,{recursive:true,force:true});}
});
test('installer lock rejects contention and releases after errors',async()=>{
 const root=await temporary('mzr-lock-');
 try{await withInstallLock(root,async()=>{await assert.rejects(withInstallLock(root,async()=>{}),/installation is running/)});await assert.rejects(withInstallLock(root,async()=>{throw new Error('fixture failure')}),/fixture failure/);await withInstallLock(root,async()=>saveState(path.join(root,'installation.json'),{current:'fixture'}));assert.equal(JSON.parse(await readFile(path.join(root,'installation.json'))).current,'fixture');}finally{await rm(root,{recursive:true,force:true});}
});
