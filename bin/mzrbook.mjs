#!/usr/bin/env node
// The `mzrbook` command. It is the same launcher as `mzr`; this entry only tells the
// application which name the person typed so its help and hints say `mzrbook`.
process.env.MZR_COMMAND_NAME = 'mzrbook';
await import('./mzr.mjs');
