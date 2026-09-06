import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Documentation-only helper. No dependencies, application code or network access.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decoder = new TextDecoder('utf-8', { fatal: true });

async function documents(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await documents(target)));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(target);
  }
  return result.sort();
}

function withinRoot(target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function checkDocs({ format = false } = {}) {
  const files = [path.join(root, 'README.md'), ...(await documents(path.join(root, 'docs')))];
  const issues = [];
  let localLinks = 0;
  let tables = 0;
  let fencedBlocks = 0;
  let formattedFiles = 0;
  for (const file of files) {
    if (!withinRoot(file)) throw new Error('Document outside workspace');
    const name = path.relative(root, file).replaceAll(path.sep, '/');
    let content = decoder.decode(await readFile(file));
    if (format) {
      const normalized = content
        .replace(/\r\n?/g, '\n')
        .replace(/[\t ]+$/gm, '')
        .replace(/\n*$/, '\n');
      if (normalized !== content) {
        await writeFile(file, normalized, 'utf8');
        formattedFiles++;
      }
      content = normalized;
    }
    if (!content.trim()) issues.push(`${name}: empty document`);
    if (/[\t ]+$/m.test(content)) issues.push(`${name}: trailing whitespace`);
    if (!content.endsWith('\n')) issues.push(`${name}: missing final newline`);
    if ((content.match(/^# /gm) ?? []).length !== 1) issues.push(`${name}: expected one H1`);
    let inFence = false;
    let tableWidth = 0;
    for (const [index, line] of content.split('\n').entries()) {
      const location = `${name}:${index + 1}`;
      if (line.startsWith('```')) {
        inFence = !inFence;
        if (inFence) fencedBlocks++;
        tableWidth = 0;
        continue;
      }
      if (inFence) continue;
      if (line.startsWith('|')) {
        const width = (line.match(/(?<!\\)\|/g) ?? []).length;
        if (tableWidth === 0) {
          tableWidth = width;
          tables++;
        } else if (width !== tableWidth)
          issues.push(`${location}: inconsistent table cells (escape inline pipes)`);
      } else tableWidth = 0;
      for (const match of line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].replace(/^<|>$/g, '');
        if (/^(https?:\/\/|mailto:|#)/.test(target)) continue;
        const localPart = target.split('#')[0];
        if (!localPart) continue;
        localLinks++;
        const destination = path.resolve(path.dirname(file), localPart);
        if (!withinRoot(destination)) issues.push(`${location}: link outside workspace`);
        else if (
          !(await stat(destination).then(
            (value) => value.isFile(),
            () => false,
          ))
        ) {
          issues.push(`${location}: missing local link ${target}`);
        }
      }
    }
    if (inFence) issues.push(`${name}: unclosed code fence`);
  }
  if (issues.length) throw new Error(issues.join('\n'));
  return {
    status: 'PASS',
    mode: format ? 'FORMAT + DOC LINT' : 'DOC LINT',
    documents: files.length,
    formattedFiles,
    localLinks,
    tables,
    fencedBlocks,
    scope:
      'UTF-8, whitespace, H1, fences, table cells, local file links. No remote-link, Mermaid-render, TypeScript or runtime tests.',
  };
}
