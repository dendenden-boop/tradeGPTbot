import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decimalMetadata } from '../src/generated/decimal-metadata.js';

const generatorUrl = new URL(
  '../../../scripts/generate-database-decimal-metadata.mjs',
  import.meta.url,
);
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
function parse(source: string): { status: number | null; output: string } {
  const script = `import { readFileSync } from 'node:fs';
    import { parseDecimalMetadata } from ${JSON.stringify(generatorUrl.href)};
    process.stdout.write(JSON.stringify(parseDecimalMetadata(readFileSync(0, 'utf8'))));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    input: source,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(child.error).toBeUndefined();
  return { status: child.status, output: child.stdout };
}
const field = '/// @decimal amount 38,18 signed\n  amount Decimal @db.Decimal';
const valid = `model Fixture {\n  id String @id\n  ${field}\n}\n`;

describe('generated schema decimal metadata', () => {
  it('covers every current model and decimal declaration without stale generated output', () => {
    const result = parse(schema);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toEqual(decimalMetadata);
    expect(Object.keys(decimalMetadata)).toHaveLength(59);
    const models: Readonly<Record<string, Readonly<Record<string, { readonly kind: string }>>>> =
      decimalMetadata;
    const fields = Object.values(models).flatMap((model) => Object.values(model));
    expect(fields.filter((entry) => entry.kind === 'decimal')).toHaveLength(61);
    expect([...schema.matchAll(/^\s+\w+\s+Decimal\??\s/gmu)]).toHaveLength(61);
  });
  it('accepts reviewed scalar, enum, optional and relation syntax with CRLF', () => {
    const result = parse(
      `${valid}enum Status {\n OK\n}\nmodel Parent {\n id String @id\n status Status\n json Json?\n fixtures Fixture[]\n}\n`.replace(
        /\n/gu,
        '\r\n',
      ),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      Parent: {
        status: { kind: 'other' },
        json: { kind: 'other' },
        fixtures: { kind: 'relation', model: 'Fixture' },
      },
    });
  });
  it.each([
    '',
    valid + valid,
    valid.replace('amount Decimal', 'amount Unsupported("money")'),
    valid.replace('amount Decimal', 'amount UnresolvedComposite'),
    valid.replace(field, 'amount Decimal @db.Decimal'),
    valid.replace('38,18', '48,18'),
    valid.replace('38,18', '38,17'),
    valid.replace('amount 38,18', 'unknown 38,18'),
    valid.replace('amount Decimal', 'amount String'),
    valid.replace('amount Decimal @db.Decimal', ''),
    valid.replace('amount Decimal', 'id Decimal'),
    valid + 'model UnsupportedInline { id String @id }\n',
    valid + '  model Indented {\n id String @id\n}\n',
  ])('fails generation rather than silently losing fields (%#)', (source) => {
    const result = parse(source);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });
});
