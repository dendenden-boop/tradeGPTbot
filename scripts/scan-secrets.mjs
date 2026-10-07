import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately narrow credential signatures, not an entropy score or complete
// substitute for provider-side secret scanning. Never include matching bytes.
const signatures = [
  ['GITHUB_TOKEN', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['GITHUB_FINE_GRAINED_TOKEN', /\bgithub_pat_[A-Za-z0-9_]{80,}\b/g],
  ['AWS_ACCESS_KEY', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['SLACK_TOKEN', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
];

export function secretFindings(name, bytes) {
  if (bytes.length > 4 * 1024 * 1024) throw new Error('SECRET_SCAN_FILE_CAPACITY');
  const text = bytes.toString('utf8');
  const findings = [];
  if (/(^|\/)\.env(?:\..+)?$/.test(name) && name !== '.env.example')
    findings.push({ file: name, line: 1, kind: 'TRACKED_ENV_FILE' });
  for (const [kind, pattern] of signatures) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ file: name, line: text.slice(0, match.index).split('\n').length, kind });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind, 'en'));
}

export function scanRepository(root, git = 'git') {
  // Only the exact source tree shipped to CI: ignored local credentials are
  // neither opened nor copied into reports. Symlinks cannot escape the tree.
  const files = execFileSync(git, ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  const symlinks = execFileSync(git, ['ls-files', '-s', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
    .split('\0')
    .filter((line) => line.startsWith('120000 '));
  if (symlinks.length) throw new Error('SECRET_SCAN_TRACKED_SYMLINK');
  const findings = files.flatMap((file) => {
    const path = resolve(root, file),
      info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('SECRET_SCAN_FILE_KIND');
    if (info.size > 4 * 1024 * 1024) throw new Error('SECRET_SCAN_FILE_CAPACITY');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // All content reads use this owned descriptor. Replacing the path or
      // growing its contents cannot turn the pre-read size bound into a guess.
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
        throw new Error('SECRET_SCAN_FILE_CHANGED');
      if (opened.size > 4 * 1024 * 1024) throw new Error('SECRET_SCAN_FILE_CAPACITY');
      if (
        opened.size !== info.size ||
        opened.mtimeMs !== info.mtimeMs ||
        opened.ctimeMs !== info.ctimeMs
      )
        throw new Error('SECRET_SCAN_FILE_CHANGED');
      const bytes = Buffer.alloc(opened.size + 1);
      let used = 0;
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, null);
        if (!count) break;
        used += count;
      }
      const after = fstatSync(fd);
      if (
        used !== opened.size ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        throw new Error('SECRET_SCAN_FILE_CHANGED');
      return secretFindings(file, bytes.subarray(0, used));
    } finally {
      closeSync(fd);
    }
  });
  return {
    status: findings.length ? 'FAIL' : 'PASS',
    files: files.length,
    findings,
    scope:
      'Tracked source; provider token signatures, private-key headers and unexpected .env files. No entropy or historical scan.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = scanRepository(process.cwd(), process.env['CTP_GIT_BINARY'] ?? 'git');
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/secrets.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (report.status !== 'PASS') process.exitCode = 1;
}
