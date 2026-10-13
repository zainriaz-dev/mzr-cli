#!/usr/bin/env node
// The `mzr` command. Checks the machine first, then hands over to the launcher.
import { runtimeProblem } from '../lib/runtime.mjs';
const problem = runtimeProblem();
if (problem && !process.argv.slice(2).some(a => a === 'doctor' || a === 'bootstrap-help' || a === '--bootstrap-help')) {
  console.error(problem);
  process.exit(1);
}
await import('../lib/cli.mjs');
