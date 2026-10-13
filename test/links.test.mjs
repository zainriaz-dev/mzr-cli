import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { download, validBinary, checkLink } from '../lib/install.mjs';
import { releaseLinks } from '../lib/links.mjs';

const config = {
  allowedDownloadOrigins: ['https://gateway.test'], linkService: 'https://links.test',
  signedDownloads: { origin: 'https://storage.test', pathPrefix: '/mzrprodg-releases/releases/' },
};
const SIGNED = 'https://storage.test/mzrprodg-releases/releases/0.2.4/mzr-win32-x64.exe?X-Goog-Signature=ab';

async function fixture(action) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mzr-links-'));
  const bytes = Buffer.from('Synthetic signed-link artifact, long enough to split in two parts');
  const asset = { format: 'binary', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  try { await action({ file: path.join(root, 'mzr'), bytes, asset }); } finally { await rm(root, { recursive: true, force: true }); }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('signed links are accepted only on the pinned storage host and bucket path', () => {
  checkLink({ url: SIGNED, signed: true }, config);
  checkLink({ url: 'https://gateway.test/v1/artifacts/0.2.4/win32-x64', signed: false }, config);
  for (const link of [
    { url: 'https://storage.test/other-bucket/releases/0.2.4/mzr', signed: true },
    { url: 'https://storage.test/mzrprodg-releases/releases/../x', signed: true },
    { url: 'https://evil.test/mzrprodg-releases/releases/0.2.4/mzr', signed: true },
    { url: 'http://storage.test/mzrprodg-releases/releases/0.2.4/mzr', signed: true },
    { url: 'https://u:p@storage.test/mzrprodg-releases/releases/0.2.4/mzr', signed: true },
    { url: SIGNED, signed: false },
    { url: 'https://gateway.test/v1/artifacts/0.2.4/win32-x64', signed: true },
  ]) assert.throws(() => checkLink(link, config), /Untrusted download origin/, link.url);
});

test('the link service gets the token; the signed link gets nothing but a Range', () => fixture(async ({ file, bytes, asset }) => {
  const seen = [];
  let issued = 0;
  const fetcher = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (url.startsWith('https://links.test/')) { issued++; return json({ url: SIGNED + issued, expires_in: 300 }); }
    // The first request drops after 10 bytes; the retry resumes from there.
    if (!init.headers.Range) return new Response(bytes.subarray(0, 10));
    return new Response(bytes.subarray(10), { status: 206, headers: { 'content-range': `bytes 10-${bytes.length - 1}/${bytes.length}` } });
  };
  const next = releaseLinks({ config, version: '0.2.4', platform: 'win32-x64', access: 'tok', team: 'mzr', fetch: fetcher, legacy: async () => { throw Error('legacy must not run'); } });
  // A short first reply is continued with a range request, which asks for its own fresh link.
  await download(next, file, asset, config, 'tok', 'mzr', fetcher);
  assert.ok(await validBinary(file, asset));
  const service = seen.filter(s => s.url.startsWith('https://links.test/'));
  assert.equal(service.length, 2, 'a fresh link for every attempt');
  assert.equal(service[0].url, 'https://links.test/v1/links/0.2.4/win32-x64');
  assert.equal(service[0].headers.Authorization, 'Bearer tok');
  assert.equal(service[0].headers['X-MZR-Team'], 'mzr');
  for (const call of seen.filter(s => s.url.startsWith('https://storage.test/'))) {
    assert.deepEqual(Object.keys(call.headers).filter(k => k !== 'Range'), [], 'no credentials go to the storage host');
  }
}));

test('a release the service does not host, or a service that is down, uses the older route', async () => {
  for (const reply of [() => json({ error: 'not_in_cloud_storage' }, 404), () => json({}, 503), () => { throw new TypeError('fetch failed'); }]) {
    let legacy = 0;
    const next = releaseLinks({ config, version: '0.2.4', platform: 'win32-x64', access: 'tok', fetch: async () => reply(), legacy: async () => { legacy++; return 'https://gateway.test/v1/artifacts/0.2.4/win32-x64'; } });
    assert.deepEqual(await next(), { url: 'https://gateway.test/v1/artifacts/0.2.4/win32-x64', signed: false });
    assert.equal(legacy, 1);
  }
  const none = releaseLinks({ config, version: '0.2.4', platform: 'win32-x64', access: 'tok', fetch: async () => json({}, 404), legacy: async () => undefined });
  await assert.rejects(none(), /not available for download yet/);
});

test('a refusal because of who you are is final: no fallback and no retry', async () => {
  for (const status of [401, 403]) {
    let legacy = 0;
    const next = releaseLinks({ config, version: '0.2.4', platform: 'win32-x64', access: 'tok', fetch: async () => json({ error: 'not_allowed' }, status), legacy: async () => { legacy++; return 'x'; } });
    await assert.rejects(next(), error => error.transient === false && /sign in again or check team access/.test(error.message));
    assert.equal(legacy, 0);
  }
});

test('an unreadable or oversized link reply never becomes a link', async () => {
  for (const body of ['not json', 'x'.repeat(20000), JSON.stringify({ url: 5 })]) {
    const next = releaseLinks({ config, version: '0.2.4', platform: 'win32-x64', access: 'tok', fetch: async () => new Response(body), legacy: async () => 'https://gateway.test/v1/artifacts/0.2.4/win32-x64' });
    assert.equal((await next()).signed, false);
  }
});
