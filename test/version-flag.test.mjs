import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

// An empty cache folder and no network proxy: if the command tried to sign in it would hang or print the approval link.
async function run(bin, ...args) {
  const home = await mkdtemp(path.join(tmpdir(), 'mzr-version-'));
  const env = { ...process.env, LOCALAPPDATA: home, XDG_CACHE_HOME: home, HOME: home, USERPROFILE: home };
  return spawnSync(process.execPath, [new URL(`../bin/${bin}.mjs`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { env, encoding: 'utf8', timeout: 15000 });
}

test('--version, -v and version print the launcher version without signing in', async () => {
  for (const [bin, flag] of [['mzrbook', '--version'], ['mzr', '-v'], ['mzr', 'version']]) {
    {
      const r = await run(bin, flag);
      assert.equal(r.status, 0, `${bin} ${flag}: ${r.stderr}`);
      assert.ok(r.stdout.startsWith(`mzrbook launcher ${version}\n`), r.stdout);
      assert.match(r.stdout, /MZR Books app not installed yet/);
      assert.doesNotMatch(r.stdout + r.stderr, /approve|open this link/i);
    }
  }
});
