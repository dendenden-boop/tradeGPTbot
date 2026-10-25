import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const rootRequire = createRequire(import.meta.url);
const packageRequire = (name) =>
  createRequire(new URL(`../packages/${name}/package.json`, import.meta.url));
const zodEdges = [
  'config',
  'exchange-binance',
  'exchange-bybit',
  'exchange-core',
  'exchange-htx',
  'exchange-okx',
  'market-data',
  'order-engine',
  'paper-engine',
  'portfolio',
  'risk-engine',
];

// Tiny inputs and invocation counters reproduce resource amplification without
// allocating hostile-sized collections or depending on wall-clock thresholds.
it.each(zodEdges)('installed %s Zod rejects oversized arrays before parsing elements', (edge) => {
  const { z } = packageRequire(edge)('zod');
  let parsed = 0;
  const element = z.string().transform((value) => {
    parsed++;
    return value;
  });
  for (const schema of [z.array(element).max(1), z.array(element).length(1)]) {
    const result = schema.safeParse(['a', 'b']);
    expect(result.success).toBe(false);
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].code).toBe('too_big');
  }
  expect(parsed).toBe(0);
});

it.each(zodEdges)('installed %s Zod bounds asynchronous element work', async (edge) => {
  const { z } = packageRequire(edge)('zod');
  let parsed = 0;
  const schema = z
    .array(
      z.string().transform(async (value) => {
        parsed++;
        return value;
      }),
    )
    .max(1);
  expect((await schema.safeParseAsync(['a', 'b'])).success).toBe(false);
  expect(parsed).toBe(0);
});

it.each(zodEdges)('installed %s Zod rejects oversized sets and maps before entry work', (edge) => {
  const { z } = packageRequire(edge)('zod');
  let parsed = 0;
  const element = z.string().transform((value) => {
    parsed++;
    return value;
  });
  const set = z
    .set(element)
    .max(1)
    .safeParse(new Set(['a', 'b']));
  const map = z
    .map(element, element)
    .max(1)
    .safeParse(
      new Map([
        ['a', '1'],
        ['b', '2'],
      ]),
    );
  for (const result of [set, map]) {
    expect(result.success).toBe(false);
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].code).toBe('too_big');
  }
  expect(parsed).toBe(0);
});

it.each(zodEdges)('installed %s Zod preserves valid bounded transformations', (edge) => {
  const { z } = packageRequire(edge)('zod');
  const element = z.string().transform((value) => value.toUpperCase());
  expect(z.array(element).max(1).parse(['a'])).toEqual(['A']);
  expect(
    z
      .set(element)
      .max(1)
      .parse(new Set(['a'])),
  ).toEqual(new Set(['A']));
  expect(
    z
      .map(element, element)
      .max(1)
      .parse(new Map([['a', 'b']])),
  ).toEqual(new Map([['A', 'B']]));
});

const smtpRequire = createRequire(rootRequire.resolve('smtp-server/package.json'));
const mailEdges = [
  ['Auth', packageRequire('auth')],
  ['SMTP fixture', smtpRequire],
];
const mailCases = [
  ['nested comment', 'Victim (x(y) <attacker@attacker.invalid>) <safe@allowed.invalid>'],
  ['group comment semicolon', 'Group: (a; <attacker@attacker.invalid>) <safe@allowed.invalid>;'],
  ['quoted local delimiter', '<"a@attacker.invalid>"@allowed.invalid>'],
];
for (const [edge, require] of mailEdges) {
  it.each(mailCases)(
    'installed ' + edge + ' address parser preserves recipient for %s',
    (_kind, input) => {
      const recipients = require('nodemailer/lib/addressparser')(input, { flatten: true });
      expect(recipients).toHaveLength(1);
      expect(recipients[0].address.endsWith('@allowed.invalid')).toBe(true);
    },
  );
  it('installed ' + edge + ' address parser retains normal recipient lists', () => {
    expect(
      require('nodemailer/lib/addressparser')('One <one@allowed.invalid>, two@allowed.invalid', {
        flatten: true,
      }).map((item) => item.address),
    ).toEqual(['one@allowed.invalid', 'two@allowed.invalid']);
  });
}

// Resolve both actual Fastify dependency majors, not independent test packages.
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const fastifyRequire = createRequire(apiRequire.resolve('fastify/package.json'));
const compilerRequire = createRequire(fastifyRequire.resolve('@fastify/ajv-compiler'));
const ajvRequire = createRequire(compilerRequire.resolve('ajv'));
const uriEdges = [
  ['AJV compiler', compilerRequire('fast-uri')],
  ['AJV schema', ajvRequire('fast-uri')],
];
for (const [edge, uri] of uriEdges) {
  it('installed ' + edge + ' URI parser cannot activate encoded schemes', () => {
    expect(uri.parse('%68ttps://allowed.invalid/').error).toBeTruthy();
    expect(uri.equal('%68ttps://allowed.invalid/', 'https://allowed.invalid/')).toBe(false);
  });
  it('installed ' + edge + ' URI normalization preserves relative target identity', () => {
    const base = 'https://allowed.invalid/directory/document';
    for (const ref of ['../item', 'a/../item']) {
      expect(uri.resolve(base, uri.normalize(ref))).toBe(uri.resolve(base, ref));
    }
  });
  it('installed ' + edge + ' URI parser rejects ambiguous host canonicalization', () => {
    for (const input of ['https://a@b@other.invalid/', 'https://allow\ted.invalid/']) {
      expect(uri.parse(input).error).toBeTruthy();
    }
  });
  it('installed ' + edge + ' URI suffix output cannot acquire a scheme', () => {
    const output = uri.normalize('custom:fixture', { reference: 'suffix' });
    expect(uri.parse(output).scheme).toBeUndefined();
    expect(output).toContain('%3A');
  });
  it('installed ' + edge + ' URI parser retains ordinary absolute and relative URLs', () => {
    const base = 'https://allowed.invalid/directory/document';
    expect(uri.parse(base).error).toBeUndefined();
    expect(uri.parse(base).host).toBe('allowed.invalid');
    expect(uri.resolve(base, '../item')).toBe('https://allowed.invalid/item');
  });
}
