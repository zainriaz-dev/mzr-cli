import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,utimes,access,realpath} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import {withInstallLock,staleLock,LOCK_STALE_MS,download} from '../lib/install.mjs';
import {createHash} from 'node:crypto';

// Resolve /var -> /private/var on macOS: installation refuses symlinked directories.
const temporary=async prefix=>realpath(await mkdtemp(path.join(tmpdir(),prefix)));

test('a lock left by an interrupted launcher is recovered automatically',async()=>{
  const root=await temporary('mzr-stale-');
  try{
    const lock=path.join(root,'installer.lock');
    // Exactly what 0.1.x left behind after Ctrl+C: no host, a dead process.
    await writeFile(lock,JSON.stringify({pid:20100,startedAt:'2026-10-06T23:52:53.186Z'}));
    let ran=false;
    await withInstallLock(root,async()=>{ran=true;},()=>false);
    assert.equal(ran,true);
    await assert.rejects(access(lock));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a live installer is never interrupted, and a stopped heartbeat is',async()=>{
  const root=await temporary('mzr-live-');
  try{
    const lock=path.join(root,'installer.lock');
    await writeFile(lock,JSON.stringify({pid:4242,host:hostname(),token:'other'}));
    await assert.rejects(withInstallLock(root,async()=>{},()=>true),/running right now/);
    assert.equal(JSON.parse(await readFile(lock,'utf8')).token,'other','live lock must stay untouched');
    const old=new Date(Date.now()-LOCK_STALE_MS-5000);await utimes(lock,old,old);
    assert.equal(await staleLock(lock,()=>true),true);
    await withInstallLock(root,async()=>{},()=>true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('an unwritten lock record is recovered only after a grace period',async()=>{
  const root=await temporary('mzr-empty-');
  try{
    const lock=path.join(root,'installer.lock');
    await writeFile(lock,'');
    assert.equal(await staleLock(lock,()=>true),false);
    const old=new Date(Date.now()-60000);await utimes(lock,old,old);
    assert.equal(await staleLock(lock,()=>true),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the lock records owner, host and token and is released after errors',async()=>{
  const root=await temporary('mzr-owner-');
  try{
    await withInstallLock(root,async()=>{
      const record=JSON.parse(await readFile(path.join(root,'installer.lock'),'utf8'));
      assert.equal(record.pid,process.pid);assert.equal(record.host,hostname());assert.match(record.token,/^[a-f0-9]{32}$/);
    });
    await assert.rejects(withInstallLock(root,async()=>{throw new Error('boom');}),/boom/);
    await assert.rejects(access(path.join(root,'installer.lock')));
  }finally{await rm(root,{recursive:true,force:true});}
});

function asset(bytes){return {format:'binary',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
const config={allowedDownloadOrigins:['https://downloads.example']};

test('Ctrl+C pauses a download, keeps the partial file and resumes it',async()=>{
  const root=await temporary('mzr-pause-');
  try{
    const bytes=Buffer.alloc(200000,7);const a=asset(bytes);const dest=path.join(root,'0.1.2','win32-x64','mzr.exe');
    const controller=new AbortController();
    const slow=async(url,init)=>new Response(new ReadableStream({async pull(c){
      if(init.signal.aborted){c.error(init.signal.reason);return;}
      c.enqueue(bytes.subarray(0,50000));controller.abort();await new Promise(r=>setTimeout(r,20));c.error(new Error('aborted'));
    }}),{status:200,headers:{'content-length':String(bytes.length)}});
    await assert.rejects(download('https://downloads.example/x',dest,a,config,'t','',slow,{signal:controller.signal}),/paused/);
    await assert.rejects(access(dest));
    const partial=(await readFile(dest+'.partial')).length;assert.ok(partial>0,'partial progress not kept');
    let range='';
    const resume=async(url,init)=>{range=init.headers.Range;const start=Number(range.match(/bytes=(\d+)-/)[1]);
      return new Response(bytes.subarray(start),{status:206,headers:{'content-range':`bytes ${start}-${bytes.length-1}/${bytes.length}`,'content-length':String(bytes.length-start)}});};
    await download('https://downloads.example/x',dest,a,config,'t','',resume);
    assert.equal(range,`bytes=${partial}-`);
    assert.deepEqual(await readFile(dest),bytes);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a stalled download fails clearly instead of hanging',async()=>{
  const root=await temporary('mzr-stall-');
  try{
    const bytes=Buffer.alloc(1000,1);const a=asset(bytes);
    const stuck=async(url,init)=>new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,10));init.signal.addEventListener('abort',()=>c.error(init.signal.reason));}}),{status:200});
    await assert.rejects(download('https://downloads.example/x',path.join(root,'mzr'),a,config,'t','',stuck,{stallMs:50}),/stalled/);
  }finally{await rm(root,{recursive:true,force:true});}
});
