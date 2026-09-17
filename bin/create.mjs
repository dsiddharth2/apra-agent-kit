#!/usr/bin/env node
// bin/create.mjs
// npm create @dsiddharth2/fleet-agent <dir>
//
// Copies the published framework folders into the target, overlays template/,
// substitutes the project name, then offers to install what is missing. Only a
// bad target or a bad name aborts: once files are written they are correct,
// and every later step is an optimisation the doctor can re-report.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { copyTree, PUBLISHED_DIRS, RENAME_ON_WRITE } from '../create/copy.mjs';
import { validateProjectName, substitute } from '../create/substitute.mjs';
import { createProbes, runChecks, formatChecks } from '../create/doctor.mjs';
import { confirm } from '../create/prompt.mjs';

const thisPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'no-install': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return {
    target: positionals[0] ?? null,
    noInstall: values['no-install'],
    yes: values.yes,
    force: values.force,
    help: values.help,
  };
}

function isEmptyDir(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0;
}

function run(command, args, { cwd }) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

export async function generate(options, io = { write: console.log }) {
  const {
    target,
    name,
    packageRoot = thisPackageRoot,
    noInstall = false,
    yes = false,
    force = false,
  } = options;
  const write = io.write;

  // Both validations run before a single byte is written.
  validateProjectName(name);
  if (!force && !isEmptyDir(target)) {
    throw new Error(
      `${target} is not empty. Choose another directory, or pass --force to generate into it anyway.`,
    );
  }

  const createdRoot = !fs.existsSync(target);
  let written = [];

  try {
    write(`\n  Creating ${name}…`);
    fs.mkdirSync(target, { recursive: true });

    for (const rel of PUBLISHED_DIRS) {
      const src = path.join(packageRoot, rel);
      if (!fs.existsSync(src)) {
        throw new Error(`the package is incomplete: ${rel} is missing from ${packageRoot}`);
      }
      written = written.concat(copyTree(src, path.join(target, rel)));
    }
    write('  ✓ copied kit (mcp, pool, host, transport, comm)');

    copyTree(path.join(packageRoot, 'template'), target, {
      overwrite: true,
      rename: RENAME_ON_WRITE,
    });
    write('  ✓ starter workflow: workflows/hello');

    // The doctor is the one file written to a path other than its source: a
    // generated project depends on nothing, so it cannot import it.
    copyTree(
      path.join(packageRoot, 'create', 'doctor.mjs'),
      path.join(target, 'scripts', 'doctor.mjs'),
      { overwrite: true },
    );

    const kitVersion = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ).version;
    substitute(target, name, kitVersion);
  } catch (err) {
    if (createdRoot) fs.rmSync(target, { recursive: true, force: true });
    throw err;
  }

  const probes = createProbes({ cwd: target });
  let checks = runChecks(probes);

  if (!noInstall) {
    try {
      run('npm', ['install'], { cwd: target });
      write('  ✓ npm install');
    } catch {
      write('  ! npm install failed — your files are fine. Run it yourself when ready.');
    }

    const missing = checks.filter((c) => !c.ok).map((c) => c.id);

    if (missing.includes('apra-fleet') || missing.includes('claude')) {
      const accepted = await confirm(
        {
          title: 'apra-fleet is not installed.',
          why:
            'Fleet is the runtime your workflows execute on. Without it, workflows ' +
            'cannot resolve @apralabs/apra-fleet-workflow and will fail on first run. ' +
            'It installs globally, outside this project, because Fleet is a machine ' +
            'install, not a dependency.',
          question: 'Install now?',
          yes,
        },
        { write },
      );

      if (accepted) {
        try {
          run('npm', ['i', '-g', '@apralabs/apra-fleet', '@anthropic-ai/claude-code'], { cwd: target });
          write('  ✓ npm i -g @apralabs/apra-fleet @anthropic-ai/claude-code');
          run('apra-fleet', ['install', '--skill', 'none'], { cwd: target });
          write('  ✓ apra-fleet install --skill none');
        } catch {
          write('  ! the global install failed. Run it yourself:');
          write('      npm i -g @apralabs/apra-fleet @anthropic-ai/claude-code');
          write('      apra-fleet install --skill none');
        }
      }
    }

    try {
      run('git', ['init', '--quiet'], { cwd: target });
      write('  ✓ git init');
    } catch {
      write('  ! git init failed — the project does not require git.');
    }

    checks = runChecks(createProbes({ cwd: target }));
  }

  const remaining = checks.filter((c) => !c.ok);
  if (remaining.length > 0) {
    write('\n  Still to do:');
    write(formatChecks(remaining));
  }

  write(`\n  cd ${path.relative(process.cwd(), target) || '.'}`);
  write('  npm test           # mock tests, no token needed');
  write('  npm run hello      # the starter workflow, for real');
  write('  npm run doctor     # re-check this environment at any time\n');

  return { dir: target, written, checks };
}

const HELP = `
  npm create @dsiddharth2/fleet-agent <directory> [options]

  --no-install   copy and substitute only; run no npm, no git, no prompts
  --yes, -y      accept every prompt without asking
  --force        generate into a non-empty directory
  --help, -h     show this message
`;

async function cli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  let target = args.target;
  if (!target) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      target = (await rl.question('  Project name: ')).trim();
    } finally {
      rl.close();
    }
  }

  const name = path.basename(path.resolve(target));
  try {
    await generate({ ...args, target: path.resolve(target), name });
    return 0;
  } catch (err) {
    console.error(`\n  ${err?.message ?? err}\n`);
    return 1;
  }
}

function isMainModule() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(invoked) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  process.exit(await cli());
}
