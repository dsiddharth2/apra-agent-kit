// create/prompt.mjs
// Global installs modify the machine outside the project directory and may
// require sudo. A user cannot consent to that from "(Y/n)" alone, so every
// prompt prints purpose, consequence and scope before it asks.
import readline from 'node:readline/promises';

function wrap(text, width = 66, indent = '    ') {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
    } else if ((line + ' ' + word).length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines.join('\n');
}

export function installPromptTitle(missing) {
  const names = ['apra-fleet', 'claude'].filter((id) => missing.includes(id));
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is not installed.`;
  return `${names.join(' and ')} are not installed.`;
}

export function formatPrompt({ title, why, question, defaultAnswer = true }) {
  const suffix = defaultAnswer ? '(Y/n)' : '(y/N)';
  return [`  ${title}`, wrap(why), `  ${question} ${suffix}`].join('\n');
}

async function defaultAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function confirm(options, { ask = defaultAsk, write = console.log } = {}) {
  const { yes = false, defaultAnswer = true } = options;
  write(formatPrompt({ ...options, defaultAnswer }));

  if (yes) return true;

  const reply = (await ask('> ')).trim().toLowerCase();
  if (reply === 'y' || reply === 'yes') return true;
  if (reply === 'n' || reply === 'no') return false;
  return defaultAnswer;
}
