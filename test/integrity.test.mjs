import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {verifyManifest,download,validBinary} from '../lib/install.mjs';
// Disposable fixture keys only, not project signing material.
test('signed manifests reject tampering and expired trust',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const config={publicKeys:{fixture:publicKey.export({type:'spki',format:'der'}).toString('base64')}};
 const bytes=Buffer.from(JSON.stringify({version:'0.1.0',expiresAt:new Date(Date.now()+3600000).toISOString(),assets:{}}));
 const signature=sign(null,bytes,privateKey).toString('base64');
 assert.equal(verifyManifest(bytes,signature,'fixture',config).version,'0.1.0');
 assert.throws(()=>verifyManifest(Buffer.from(bytes.toString().replace('0.1.0','9.9.9')),signature,'fixture',config),/signature/);
 const expired=Buffer.from(JSON.stringify({version:'0.1.0',expiresAt:'2000-01-01',assets:{}}));
 assert.throws(()=>verifyManifest(expired,sign(null,expired,privateKey).toString('base64'),'fixture',config),/expired/);
});
test('resumed downloads verify complete bytes before installation',async()=>{
 // Canonicalize only the test-owned root; macOS /var aliases /private/var.
 const directory=await realpath(await mkdtemp(path.join(await realpath(tmpdir()),'mzr-integrity-')));const destination=path.join(directory,'space in path','mzr');
 const bytes=Buffer.from('synthetic executable fixture');const asset={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),format:'binary'};
 const original=global.fetch;let authorization;
 global.fetch=async(_url,{headers})=>{authorization=headers.Authorization;assert.equal(headers['X-MZR-Team'],'second');return new Response(bytes,{status:200});};
 try{
  await download('https://downloads.example.test/artifact',destination,asset,{allowedDownloadOrigins:['https://downloads.example.test']},'synthetic-access','second');
  assert.equal(authorization,'Bearer synthetic-access');assert(await validBinary(destination,asset));
  await writeFile(destination+'.partial',bytes.subarray(0,5));
  global.fetch=async(_url,{headers})=>{assert.equal(headers.Range,'bytes=5-');return new Response(bytes.subarray(5),{status:206,headers:{'content-range':`bytes 5-${bytes.length-1}/${bytes.length}`}});};
  await download('https://downloads.example.test/artifact',destination,asset,{allowedDownloadOrigins:['https://downloads.example.test']});
  assert.deepEqual(await readFile(destination),bytes);
  global.fetch=async()=>new Response(Buffer.alloc(bytes.length,0));
  await assert.rejects(download('https://downloads.example.test/artifact',destination,asset,{allowedDownloadOrigins:['https://downloads.example.test']}),/checksum/);
  assert.deepEqual(await readFile(destination),bytes);
 }finally{global.fetch=original;await rm(directory,{recursive:true,force:true});}
});
