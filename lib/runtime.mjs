// Dependency-free checks that run before anything else is loaded, so an
// unsupported Node or machine gets one clear sentence instead of a stack trace.
export const MINIMUM_NODE = [22, 0];
export const SUPPORTED = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const NAMES = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

export function runtimeProblem(nodeVersion = process.versions.node, os = process.platform, arch = process.arch) {
  const [major, minor] = String(nodeVersion).split('.').map(Number);
  if (!(major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]))) {
    return `MZR Books needs Node.js ${MINIMUM_NODE[0]} or newer to install itself; this is Node.js ${nodeVersion}. Install a current Node.js from https://nodejs.org and run the command again.`;
  }
  if (!SUPPORTED.includes(`${os}-${arch}`)) {
    const where = `${NAMES[os] || os} on ${arch}`;
    return `MZR Books is not built for ${where}. Supported: Windows, Linux and macOS on x64 or arm64 (${SUPPORTED.join(', ')}).`;
  }
  return '';
}
