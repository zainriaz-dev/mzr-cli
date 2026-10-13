import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm,access,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {download,validBinary,purgeInstallerCache,withInstallLock} from '../lib/install.mjs';
async function fixture(action) {
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mzr-range-'));
  const bytes=Buffer.from('Synthetic bounded raw artifact');const file=path.join(root,'mzr');
  const asset={format:'binary',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const run=fetcher=>download('https://download.test/file',file,asset,{allowedDownloadOrigins:['https://download.test']},'synthetic','',fetcher);
  try {await action({file,bytes,asset,run});}finally{await rm(root,{recursive:true,force:true});}
}
test('invalid range totals/endpoints/lengths cannot replace prior binary',()=>fixture(async({file,bytes,run})=>{
  await writeFile(file,'prior');await writeFile(file+'.partial',bytes.subarray(0,5));
  for(const headers of [ {'content-range':`bytes 5-${bytes.length-2}/${bytes.length}`}, {'content-range':`bytes 5-${bytes.length-1}/${bytes.length+1}`}, {'content-range':`bytes 5-${bytes.length-1}/${bytes.length}`,'content-length':'1'} ]) {
    await assert.rejects(run(async()=>new Response(bytes.subarray(5),{status:206,headers})),/range|length|exceeded/);
    assert.equal(await readFile(file,'utf8'),'prior');
  }
}));
test('cleanly truncated body retains partial but never installs; explicit retry resumes',()=>fixture(async({file,bytes,asset,run})=>{
  await assert.rejects(run(async()=>new Response(bytes.subarray(0,5))),/interrupted/);
  await assert.rejects(access(file));assert.equal((await readFile(file+'.partial')).length,5);
  await run(async(_url,{headers})=>{assert.equal(headers.Range,'bytes=5-');return new Response(bytes.subarray(5),{status:206,headers:{'content-range':`bytes 5-${bytes.length-1}/${bytes.length}`}});});
  assert(await validBinary(file,asset));
}));
test('complete interrupted partial is fully hashed before atomic recovery',()=>fixture(async({file,bytes,asset,run})=>{
  await writeFile(file+'.partial',bytes);
  await run(async()=>{throw Error('network must not run');});assert(await validBinary(file,asset));
}));
test('purge preserves active lock and refuses unknown contents before deleting anything',()=>fixture(async({file})=>{
  const root=path.join(path.dirname(file),'mzr-books');await mkdir(path.join(root,'0.1.0'),{recursive:true});
  await writeFile(path.join(root,'0.1.0','mzr'),'fixture');await writeFile(path.join(root,'unexpected'),'preserve');
  await assert.rejects(purgeInstallerCache(root),/Unexpected cache content/);await access(path.join(root,'0.1.0','mzr'));
  await rm(path.join(root,'unexpected'));
  await withInstallLock(root,async()=>{await purgeInstallerCache(root);await access(path.join(root,'installer.lock'));});
  await assert.rejects(access(path.join(root,'0.1.0')));
}));
test('storage that ends every range reply after one window is followed window by window',()=>fixture(async({file,bytes,asset,run})=>{
  await writeFile(file+'.partial',bytes.subarray(0,5));const asked=[];
  await run(async(_url,{headers})=>{
    asked.push(headers.Range);const start=Number(headers.Range.match(/bytes=(\d+)-/)[1]);const end=Math.min(start+10,bytes.length);
    return new Response(bytes.subarray(start,end),{status:206,headers:{'content-range':`bytes ${start}-${end-1}/${bytes.length}`,'content-length':String(end-start)}});
  });
  assert.deepEqual(asked,['bytes=5-','bytes=15-','bytes=25-']);assert(await validBinary(file,asset));
}));
test('a window that starts elsewhere or announces another file size is refused',()=>fixture(async({file,bytes,run})=>{
  await writeFile(file+'.partial',bytes.subarray(0,5));
  for(const header of [`bytes 6-${bytes.length-1}/${bytes.length}`,`bytes 5-9/${bytes.length+1}`]) {
    await assert.rejects(run(async()=>new Response(bytes.subarray(5,10),{status:206,headers:{'content-range':header}})),/Invalid resumed download range/);
  }
  await assert.rejects(access(file));
}));
