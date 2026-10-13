// One-time helper: writes a harmless placeholder package named "mzrbook" into an
// empty directory. npm only lets you attach a trusted publisher to a package that
// already exists, so this reserves the name; every real version is then published
// by the provenance-backed GitHub workflow. The placeholder has no dependencies,
// no scripts and a command that only prints one sentence.
//   node scripts/seed.mjs EMPTY_DIRECTORY
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw Error('Usage: node scripts/seed.mjs EMPTY_DIRECTORY');
await mkdir(path.join(target, 'bin'), { recursive: true });
if ((await readdir(target)).some(name => name !== 'bin') || (await readdir(path.join(target, 'bin'))).length) throw Error('The directory must be empty');

await writeFile(path.join(target, 'package.json'), JSON.stringify({
  name: 'mzrbook',
  version: '0.0.0-seed',
  description: 'Name reservation for the MZR Books installer. Install the latest version instead.',
  bin: { mzrbook: 'bin/seed.mjs' },
  files: ['bin', 'README.md'],
  license: 'UNLICENSED',
  repository: { type: 'git', url: 'git+https://github.com/zainriaz-dev/mzr-cli.git' },
  publishConfig: { access: 'public' },
}, null, 2) + '\n');
await writeFile(path.join(target, 'bin', 'seed.mjs'), "#!/usr/bin/env node\nconsole.error('This is a placeholder. Install the latest release: npm install --global mzrbook@latest');\nprocess.exitCode = 1;\n");
await writeFile(path.join(target, 'README.md'), '# mzrbook\n\nPlaceholder that reserves the package name. Install the latest release instead:\n\n    npm install --global mzrbook@latest\n');
console.log(`Placeholder written to ${target}\nNext (from that directory):\n  npm publish --provenance=false --access public --tag seed\n  npm deprecate mzrbook@0.0.0-seed "placeholder - install mzrbook@latest"`);
