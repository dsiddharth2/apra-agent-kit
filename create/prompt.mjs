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

export function installPromptWhy(missing) {
  const sentences = [];
  if (missing.includes('apra-fleet')) {
    sentences.push(
      'Fleet is the runtime your workflows execute on. Without it, workflows cannot spawn Fleet, so every run fails at startup.',
    );
  }
  if (missing.includes('claude')) {
    sentences.push(
      'Claude Code powers live agent() calls. Without it, live agent() calls fail; mock tests still pass.',
    );
  }
  if (sentences.length === 0) return '';
  const scope =
    sentences.length > 1
      ? 'They install globally, outside this project, because these are machine installs, not project dependencies.'
      : 'It installs globally, outside this project, because this is a machine install, not a project dependency.';
  return [...sentences, scope].join(' ');
}

export function formatPrompt({ title, why, question, defaultAnswer = true }) {
  const suffix = defaultAnswer ? '(Y/n)' : '(y/N)';
  return [`  ${title}`, wrap(why), `  ${question} ${suffix}`].join('\n');
}

async function defaultAsk(question) {
  if (!process.stdin.isTTY || process.stdin.readableEnded) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function isInteractive(isTTY) {
  return isTTY && !process.stdin.readableEnded;
}

export async function confirm(options, { ask = defaultAsk, write = console.log, isTTY = process.stdin.isTTY } = {}) {
  const { yes = false, defaultAnswer = true } = options;
  write(formatPrompt({ ...options, defaultAnswer }));

  if (yes) return true;
  if (!isInteractive(isTTY)) return false;

  const reply = (await ask('> ')).trim().toLowerCase();
  if (reply === 'y' || reply === 'yes') return true;
  if (reply === 'n' || reply === 'no') return false;
  return defaultAnswer;
}
