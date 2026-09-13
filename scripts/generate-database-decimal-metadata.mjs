import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This deliberately supports the repository's reviewed Prisma field syntax only.
// New schema constructs must extend this parser explicitly, never silently omit a field.
export function parseDecimalMetadata(schema) {
  const blocks = [...schema.matchAll(/^model (\w+) \{\r?\n([\s\S]*?)^\}/gmu)];
  const names = new Set(blocks.map((match) => match[1]));
  const enums = new Set([...schema.matchAll(/^enum (\w+) \{/gmu)].map((match) => match[1]));
  const scalars = new Set([
    'String',
    'Boolean',
    'Int',
    'BigInt',
    'Float',
    'Decimal',
    'DateTime',
    'Json',
    'Bytes',
  ]);
  if (
    blocks.length === 0 ||
    names.size !== blocks.length ||
    blocks.length !== [...schema.matchAll(/^\s*model\s+/gmu)].length
  )
    throw new Error('Invalid model metadata');
  const models = {};
  for (const [, name, body] of blocks) {
    const fields = {};
    let category;
    for (const raw of body.split(/\r?\n/u)) {
      const line = raw.trim();
      if (line.startsWith('/// @decimal ')) {
        const match =
          /^\/\/\/ @decimal (price|quantity|amount|aggregate|rate) (\d+),18 (?:signed|positive|nonnegative)$/u.exec(
            line,
          );
        if (!match || category) throw new Error('Invalid decimal metadata');
        const precision = {
          price: '38',
          quantity: '38',
          amount: '38',
          aggregate: '48',
          rate: '20',
        };
        if (precision[match[1]] !== match[2]) throw new Error('Invalid decimal precision');
        category = match[1];
        continue;
      }
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const field = /^(\w+)\s+(\w+)(?:\[\]|\?)?(?:\s|$)/u.exec(line);
      if (!field || Object.hasOwn(fields, field[1]))
        throw new Error('Unsupported model field syntax');
      const [, fieldName, type] = field;
      if (type === 'Decimal') {
        if (!category) throw new Error('Decimal field has no category');
        fields[fieldName] = { kind: 'decimal', category };
      } else {
        if (category) throw new Error('Decimal category belongs to a non-decimal field');
        if (names.has(type)) fields[fieldName] = { kind: 'relation', model: type };
        else if (scalars.has(type) || enums.has(type)) fields[fieldName] = { kind: 'other' };
        else throw new Error('Unresolved model field type');
      }
      category = undefined;
    }
    if (category || Object.keys(fields).length === 0) throw new Error('Incomplete model metadata');
    models[name] = fields;
  }
  return models;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const schema = await readFile(
    new URL('../packages/database/prisma/schema.prisma', import.meta.url),
    'utf8',
  );
  const metadata = parseDecimalMetadata(schema);
  await writeFile(
    new URL('../packages/database/src/generated/decimal-metadata.ts', import.meta.url),
    `// Generated from schema.prisma; do not edit.\nexport const decimalMetadata = ${JSON.stringify(metadata, null, 2)} as const;\n`,
  );
}
