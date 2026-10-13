import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { prompter } from '../lib/ask.mjs';

function setup(interactive = true) {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  let cancelled = 0;
  return { input, ask: prompter({ interactive, input, output, onCancel: () => cancelled++ }), seen: () => text, cancelled: () => cancelled };
}

test('answers, defaults and retries are read from the terminal', async () => {
  const { input, ask, seen } = setup();
  const answers = ['', 'y', 'N', 'maybe\nyes'];
  const results = [];
  for (const line of answers) {
    const pending = ask.confirm('Continue?', true);
    input.write(line + '\n');
    results.push(await pending);
  }
  assert.deepEqual(results, [true, true, false, true]);
  assert.match(seen(), /Continue\? \[Y\/n\]/);
  assert.match(seen(), /Please answer y or n/);
  ask.close();
});

test('a default of no is shown and honoured', async () => {
  const { input, ask, seen } = setup();
  const pending = ask.confirm('Delete everything?', false);
  input.write('\n');
  assert.equal(await pending, false);
  assert.match(seen(), /\[y\/N\]/);
  ask.close();
});

test('without a terminal every question takes its default and prints nothing', async () => {
  const { ask, seen } = setup(false);
  assert.equal(await ask.confirm('Continue?', true), true);
  assert.equal(await ask.confirm('Delete?', false), false);
  assert.equal(seen(), '');
  ask.close();
});

test('closed input declines instead of hanging, and garbage three times declines', async () => {
  const closing = setup();
  const pending = closing.ask.confirm('Continue?', true);
  closing.input.end();
  assert.equal(await pending, false);
  assert.equal(await closing.ask.confirm('Again?', true), false);
  const noisy = setup();
  const result = noisy.ask.confirm('Continue?', true);
  noisy.input.write('x\ny?\nwhat\n');
  assert.equal(await result, false);
  noisy.ask.close();
});
