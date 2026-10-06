import test from 'node:test';
import assert from 'node:assert/strict';
import {platform,verifyManifest,checkAsset,download} from '../lib/install.mjs';

test('platform detection uses executing OS and supported architecture',()=>{assert.equal(platform('linux','arm64'),'linux-arm64');assert.equal(platform('win32','x64'),'win32-x64');assert.throws(()=>platform('linux','ia32'));});
test('untrusted manifest keys fail closed',()=>{assert.throws(()=>verifyManifest(Buffer.from('{}'),'','unknown',{publicKeys:{}}),/not trusted/);});
test('archives and unsafe asset sizes cannot enter installer',()=>{assert.throws(()=>checkAsset({sha256:'a'.repeat(64),size:1,format:'zip'}));assert.throws(()=>checkAsset({sha256:'a'.repeat(64),size:200*1024*1024,format:'binary'}));});
test('untrusted download rejected before any filesystem write',async()=>{await assert.rejects(download('http://evil.example/file','unused',{sha256:'a'.repeat(64),size:1,format:'binary'},{allowedDownloadOrigins:[]}),/Untrusted/);});
