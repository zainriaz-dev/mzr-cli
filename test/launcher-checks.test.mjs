import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runtimeProblem, SUPPORTED } from '../lib/runtime.mjs';
import { diagnose } from '../lib/doctor.mjs';
import { packageProblems, tarballProblems, secretProblems } from '../scripts/release-check.mjs';

const read = async name => JSON.parse(await readFile(new URL('../' + name, import.meta.url), 'utf8'));

test('old Node and unsupported machines get one clear sentence', () => {
  assert.match(runtimeProblem('20.11.0', 'linux', 'x64'), /Node\.js 22 or newer.*20\.11\.0/);
  assert.match(runtimeProblem('24.1.0', 'freebsd', 'x64'), /not built for freebsd on x64/);
  assert.match(runtimeProblem('24.1.0', 'linux', 'ia32'), /not built for Linux on ia32/);
  for (const key of SUPPORTED) { const [os, arch] = key.split('-'); assert.equal(runtimeProblem('22.0.0', os, arch), ''); }
});

test('doctor reports a healthy machine without any sign-in or changes', async () => {
  const config = await read('bootstrap-config.json');
  const seen = [];
  const fetcher = async url => { seen.push(url); return new Response(null, { status: url.includes('/v1/releases') || url.includes('/v1/links/') ? 401 : 200 }); };
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'mzr-doctor-')), 'MZRBooks');
  const checks = await diagnose({ config: { ...config, configured: true }, root, platformKey: 'win32-x64', installed: null, fetch: fetcher, env: {} });
  assert.deepEqual(checks.filter(c => !c.ok), []);
  assert.ok(seen.length === 4 && seen.every(url => url.startsWith('https://')));
  assert.match(checks.find(c => c.name === 'Download link service').detail, /refusing requests without a sign-in/);
  assert.match(checks.find(c => c.name === 'MZR API').detail, /refusing unsigned requests/);
});

test('doctor accepts an install folder whose parents do not exist yet (fresh machine)', async () => {
  const config = await read('bootstrap-config.json');
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'mzr-doctor-')), '.cache', 'mzr-books');
  const checks = await diagnose({ config, root, platformKey: 'linux-x64', installed: null, fetch: async () => new Response(null, { status: 401 }), offline: true, env: {} });
  assert.deepEqual(checks.filter(c => !c.ok), []);
});

test('doctor flags a disabled launcher, a dead service and a stray HTTP answer', async () => {
  const config = await read('bootstrap-config.json');
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'mzr-doctor-')), 'MZRBooks');
  const down = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const checks = await diagnose({ config: { ...config, configured: false }, root, platformKey: 'linux-x64', installed: null, fetch: down, env: { HTTPS_PROXY: 'http://proxy' } });
  const failed = checks.filter(c => !c.ok).map(c => c.name);
  assert.deepEqual(failed, ['Release channel', 'Sign-in service', 'MZR API', 'Download link service', 'Download gateway']);
  assert.match(checks.find(c => c.name === 'Sign-in service').detail, /ENOTFOUND/);
  assert.match(checks.find(c => c.name === 'Proxy').detail, /HTTPS_PROXY/);
  const odd = await diagnose({ config: { ...config, configured: true }, root, platformKey: 'linux-x64', installed: null, fetch: async () => new Response(null, { status: 200 }), env: {} });
  assert.match(odd.find(c => c.name === 'MZR API').detail, /unexpected answer \(HTTP 200\)/);
  const offline = await diagnose({ config: { ...config, configured: true }, root, platformKey: 'linux-x64', installed: { version: '0.2.3' }, fetch: down, offline: true, env: {} });
  assert.deepEqual(offline.filter(c => !c.ok), []);
});

test('the shipped package passes every supply-chain rule', async () => {
  assert.deepEqual(packageProblems(await read('package.json'), await read('package-lock.json'), await read('bootstrap-config.json')), []);
});

test('install-time scripts, loose dependencies and unsafe lock entries are refused', async () => {
  const pkg = await read('package.json'), lock = await read('package-lock.json'), config = await read('bootstrap-config.json');
  const has = (changed, text, l = lock, c = config) => assert.ok(packageProblems(changed, l, c).some(p => p.includes(text)), text);
  has({ ...pkg, scripts: { ...pkg.scripts, postinstall: 'node x.js' } }, 'postinstall');
  has({ ...pkg, scripts: { prepare: 'x' } }, 'prepare');
  has({ ...pkg, dependencies: { undici: '^7.30.0' } }, 'exact registry version');
  has({ ...pkg, dependencies: { undici: 'github:x/y' } }, 'exact registry version');
  has({ ...pkg, dependencies: { undici: '7.30.0', extra: '1.0.0' } }, 'missing from package-lock.json');
  has({ ...pkg, optionalDependencies: { a: '1.0.0' } }, 'only exact pinned');
  has({ ...pkg, name: '@zainriaz-dev/mzrbook' }, 'package name');
  has({ ...pkg, repository: { url: 'git+https://github.com/someone/else.git' } }, 'repository.url');
  has({ ...pkg, files: ['bin', 'lib', 'test'] }, '"files" must be exactly');
  const bad = structuredClone(lock);
  bad.packages['node_modules/undici'].resolved = 'https://evil.example/undici.tgz';
  has(pkg, 'does not resolve from the npm registry', bad);
  delete bad.packages['node_modules/undici'].integrity;
  has(pkg, 'no integrity hash', bad);
  has(pkg, 'not configured', lock, { ...config, configured: false });
  has(pkg, 'must be https', lock, { ...config, api: 'http://api.example' });
  has(pkg, 'revoked', lock, { ...config, keyPolicies: { 'mzr-root-2026-10': { ...config.keyPolicies['mzr-root-2026-10'], revoked: true } } });
  has(pkg, 'no release signing key', lock, { ...config, publicKeys: {} });
  has(pkg, 'linkService must be', lock, { ...config, linkService: 'http://links.example' });
  has(pkg, 'signedDownloads must pin', lock, { ...config, signedDownloads: { origin: 'https://storage.googleapis.com', pathPrefix: '/x/' } });
  has(pkg, 'signedDownloads must pin', lock, { ...config, signedDownloads: undefined });
  assert.ok(packageProblems(pkg, lock, config, Date.parse('2030-01-01')).some(p => p.includes('has expired')));
});

test('only launcher files may ship, and secrets are caught', () => {
  const ok = ['bin/mzr.mjs', 'bin/mzrbook.mjs', 'lib/cli.mjs', 'lib/install.mjs', 'bootstrap-config.json', 'README.md', 'package.json'].map(p => ({ path: p }));
  assert.deepEqual(tarballProblems(ok), []);
  assert.ok(tarballProblems([...ok, { path: 'test/install.test.mjs' }, { path: '.env' }]).length === 2);
  assert.ok(tarballProblems(ok.slice(1)).some(p => p.includes('missing from tarball: bin/mzr.mjs')));
  const secret = 'npm_' + 'a'.repeat(36);
  assert.deepEqual(secretProblems({ 'lib/x.mjs': 'const ok = 1;' }), []);
  assert.match(secretProblems({ 'lib/x.mjs': secret })[0], /npm token pattern in lib\/x\.mjs \(value withheld\)/);
  assert.ok(!secretProblems({ 'lib/x.mjs': secret })[0].includes(secret));
});

test('the command wrapper refuses a bad runtime but still allows help', async () => {
  const { spawnSync } = await import('node:child_process');
  const wrapper = new URL('../bin/mzrbook.mjs', import.meta.url);
  const help = spawnSync(process.execPath, [wrapper.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'bootstrap-help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /mzr doctor/);
  assert.match(help.stdout, /No postinstall authentication/);
});
