// Yes/no questions for the interactive installer. On a terminal the person is asked;
// everywhere else (pipes, CI, --yes) every question silently takes its default, so
// scripts behave exactly as they always did. Ctrl+C or closing the input declines
// and stops safely; nothing unverified is ever installed on the way.
import readline from 'node:readline';

export function prompter({ interactive, input = process.stdin, output = process.stderr, onCancel = () => {} } = {}) {
  let rl, lines;
  const open = () => {
    if (!rl) {
      rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
      rl.on('SIGINT', () => { onCancel(); rl.close(); });
      // Buffered line reader: pasted multi-line input and a closed stream both behave.
      lines = rl[Symbol.asyncIterator]();
    }
    return lines;
  };
  return {
    interactive: Boolean(interactive),
    async confirm(question, defaultYes = true) {
      if (!interactive) return defaultYes;
      const hint = defaultYes ? '[Y/n]' : '[y/N]';
      const reader = open();
      for (let attempt = 0; attempt < 3; attempt++) {
        output.write(`${question} ${hint} `);
        const { value, done } = await reader.next();
        if (done) return false; // input closed or cancelled
        const answer = String(value).trim();
        if (answer === '') return defaultYes;
        if (/^y(es)?$/i.test(answer)) return true;
        if (/^n(o)?$/i.test(answer)) return false;
        output.write('Please answer y or n.\n');
      }
      return false;
    },
    close() { rl?.close(); },
  };
}
