// create/substitute.mjs
// The project name reaches exactly three files. Validation runs before any
// write, so a bad name cannot leave a half-made directory behind.
import fs from 'node:fs';
import path from 'node:path';

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PLACEHOLDER = /\{\{PROJECT_NAME\}\}/g;

export function validateProjectName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('Project name is required.');
  }
  if (name.length > 214) {
    throw new Error('Project name must be 214 characters or fewer.');
  }
  if (name.startsWith('.') || name.startsWith('_')) {
    throw new Error('Project name cannot start with "." or "_".');
  }
  if (!NPM_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a valid npm package name. Use lowercase letters, digits, ` +
        'and - . _ ~ only, with no spaces.',
    );
  }
}

export function substitute(destDir, projectName, kitVersion) {
  const pkgPath = path.join(destDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.name = projectName;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  for (const rel of ['README.md', 'host.config.mjs']) {
    const filePath = path.join(destDir, rel);
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, text.replace(PLACEHOLDER, projectName));
    }
  }

  fs.writeFileSync(path.join(destDir, '.kit-version'), `${kitVersion}\n`);
}
