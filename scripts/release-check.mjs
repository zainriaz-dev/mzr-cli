// Gate before every npm publish: `npm run release:check`.
// Fails when the package could surprise the people who install it - install-time
// scripts, loose or remote dependencies, files that should not ship, secrets, or
// a launcher that is not enabled for real releases. Read-only; it publishes nothing.
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_FILES = [/^bin\/[a-z]+\.mjs$/, /^lib\/[a-z]+\.mjs$/, /^bootstrap-config\.json$/, /^README\.md$/, /^package\.json$/];
// Scripts npm runs on the machine of whoever installs the package. None may exist.
export const INSTALL_TIME_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['bearer credential', /Bearer\s+eyJ[A-Za-z0-9_-]{20,}/],
  ['Google private key', /"private_key"\s*:/],
];
const EXACT = /^\d+\.\d+\.\d+$/;

export function packageProblems(pkg, lock, config, now = Date.now()) {
  const problems = [];
  const fail = message => problems.push(message);
  if (pkg.name !== 'mzrbook') fail(`package name must be "mzrbook" (is "${pkg.name}")`);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version || '')) fail('version must be a plain x.y.z release');
  if (pkg.bin?.mzrbook !== 'bin/mzrbook.mjs' || pkg.bin?.mzr !== 'bin/mzr.mjs') fail('bin must expose mzrbook and mzr');
  for (const name of INSTALL_TIME_SCRIPTS) if (pkg.scripts && name in pkg.scripts) fail(`lifecycle script "${name}" would run on installing machines`);
  if (pkg.gypfile || pkg.bundleDependencies || pkg.bundledDependencies || pkg.optionalDependencies || pkg.devDependencies || pkg.peerDependencies) fail('only exact pinned "dependencies" are allowed (no dev, optional, peer or bundled)');
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (!EXACT.test(spec)) fail(`dependency ${name}@${spec} must be an exact registry version`);
    const entry = lock?.packages?.[`node_modules/${name}`];
    if (!entry) fail(`dependency ${name} is missing from package-lock.json`);
    else if (entry.version !== spec) fail(`package-lock.json has ${name}@${entry.version}, package.json pins ${spec}`);
  }
  for (const [where, entry] of Object.entries(lock?.packages || {})) {
    if (!where) continue;
    if (!entry.integrity) fail(`lockfile entry ${where} has no integrity hash`);
    if (!/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved || '')) fail(`lockfile entry ${where} does not resolve from the npm registry`);
    if (entry.hasInstallScript) fail(`lockfile entry ${where} runs install scripts`);
  }
  if (!pkg.engines?.node) fail('engines.node is required');
  if (!pkg.license) fail('license is required');
  if (pkg.publishConfig?.access !== 'public') fail('publishConfig.access must be "public"');
  if (pkg.repository?.url !== 'git+https://github.com/zainriaz-dev/mzr-cli.git') fail('repository.url must name the public repository, or provenance is rejected');
  if (JSON.stringify(pkg.files) !== JSON.stringify(['bin', 'lib', 'bootstrap-config.json', 'README.md'])) fail('"files" must be exactly bin, lib, bootstrap-config.json, README.md');
  // The launcher itself must be enabled and point only at trusted https services.
  if (config.configured !== true) fail('bootstrap-config.json is not configured: true');
  for (const field of ['api', 'issuer', 'clientId', 'applicationClientId']) if (!config[field]) fail(`bootstrap-config.json is missing ${field}`);
  for (const field of ['api', 'issuer']) if (config[field] && !String(config[field]).startsWith('https://')) fail(`${field} must be https`);
  for (const origin of config.allowedDownloadOrigins || []) if (!origin.startsWith('https://')) fail(`download origin ${origin} must be https`);
  const origin = new RegExp('^https://[a-z0-9.-]+$');
  if (!origin.test(config.linkService || '')) fail('linkService must be a plain https origin');
  const signed = config.signedDownloads || {};
  if (!origin.test(signed.origin || '') || !new RegExp('^/[a-z0-9][a-z0-9._-]*/releases/$').test(signed.pathPrefix || '')) fail('signedDownloads must pin an https storage origin and a /bucket/releases/ path');
  const keys = Object.keys(config.publicKeys || {});
  if (!keys.length) fail('no release signing key is pinned');
  for (const id of keys) {
    const policy = config.keyPolicies?.[id];
    if (!policy) fail(`key ${id} has no policy`);
    else if (policy.revoked) fail(`key ${id} is revoked`);
    else if (Date.parse(policy.notAfter) < now) fail(`key ${id} has expired`);
  }
  return problems;
}

export function tarballProblems(files) {
  const problems = [];
  for (const file of files) if (!ALLOWED_FILES.some(pattern => pattern.test(file.path))) problems.push(`unexpected file in tarball: ${file.path}`);
  for (const required of ['bin/mzr.mjs', 'bin/mzrbook.mjs', 'lib/cli.mjs', 'bootstrap-config.json', 'README.md']) if (!files.some(file => file.path === required)) problems.push(`missing from tarball: ${required}`);
  return problems;
}

export function secretProblems(contents) {
  const problems = [];
  for (const [file, text] of Object.entries(contents)) for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) problems.push(`${name} pattern in ${file} (value withheld)`);
  return problems;
}

// Fixed command strings only: nothing from the environment or package is interpolated.
function npm(command, cwd) {
  return execSync('npm ' + command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(import.meta.url), '../..');
  const read = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const pkg = await read('package.json'), lock = await read('package-lock.json'), config = await read('bootstrap-config.json');
  const problems = packageProblems(pkg, lock, config);
  const [packed] = JSON.parse(npm('pack --dry-run --json --ignore-scripts', root));
  problems.push(...tarballProblems(packed.files));
  const contents = {};
  for (const file of packed.files) contents[file.path] = await readFile(path.join(root, file.path), 'utf8');
  problems.push(...secretProblems(contents));
  if (packed.unpackedSize > 300 * 1024) problems.push(`unpacked size ${packed.unpackedSize} bytes is larger than expected`);
  try {
    const published = npm('view mzrbook versions --json', root);
    if ([].concat(JSON.parse(published)).includes(pkg.version)) problems.push(`${pkg.name}@${pkg.version} is already published; bump the version`);
  } catch { /* A package that does not exist yet (or no network) is fine here. */ }
  if (problems.length) {
    console.error(`Release check FAILED (${problems.length}):\n` + problems.map(p => '  - ' + p).join('\n'));
    process.exit(1);
  }
  console.log(`Release check passed: ${pkg.name}@${pkg.version}, ${packed.files.length} files, ${packed.size} bytes packed, no install-time scripts, 1 pinned dependency, no secrets.`);
}
