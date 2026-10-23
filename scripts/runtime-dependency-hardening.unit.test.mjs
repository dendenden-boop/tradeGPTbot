import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const authRequire = createRequire(new URL('../packages/auth/package.json', import.meta.url));
const rootRequire = createRequire(import.meta.url);
const smtpRequire = createRequire(rootRequire.resolve('smtp-server/package.json'));
const Fastify = apiRequire('fastify');

// Exercise the installed API framework through in-memory injection, with no socket.
it.each([
  ['enum', { not: { enum: ['X-Synthetic-Blocked'] } }],
  ['const', { not: { const: 'X-Synthetic-Blocked' } }],
  ['nested', { allOf: [{ not: { enum: ['X-Synthetic-Blocked'] } }] }],
])(
  'installed API headers enforce mixed-case propertyNames %s before the handler',
  async (_kind, propertyNames) => {
    const app = Fastify({ logger: false });
    let calls = 0;
    app.get(
      '/synthetic-header-contract',
      {
        schema: { headers: { type: 'object', propertyNames } },
      },
      async () => {
        calls++;
        return { ok: true };
      },
    );
    try {
      const denied = await app.inject({
        url: '/synthetic-header-contract',
        headers: { 'X-Synthetic-Blocked': 'fixture' },
      });
      expect(denied.statusCode).toBe(400);
      expect(calls).toBe(0);
      const allowed = await app.inject({
        url: '/synthetic-header-contract',
        headers: { 'X-Synthetic-Allowed': 'fixture' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  },
);

const edges = [
  ['Auth', authRequire],
  ['SMTP fixture', smtpRequire],
];
const parserFor = (require) =>
  require(join(dirname(require.resolve('nodemailer/lib/dkim')), 'message-parser.js'));

// Count bytes presented to continuation classification, rather than relying on
// wall-clock thresholds or sending a large message. Only installed parser code runs.
it.each(edges)(
  'installed %s DKIM parser classifies folded headers with linear scan volume',
  (_name, require) => {
    const Parser = parserFor(require),
      parser = new Parser();
    const continuations = Array.from({ length: 256 }, () => ' next@example.invalid,');
    const input = [
      'From: sender@example.invalid',
      'To: first@example.invalid,',
      ...continuations,
      'Subject: fixture',
    ].join('\r\n');
    parser.rawHeaders = Buffer.from(input, 'latin1');
    const original = RegExp.prototype.test;
    let classifiedBytes = 0,
      headers;
    const spy = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (value) {
      if (this.source === String.raw`^[ \t]`) classifiedBytes += String(value).length;
      return original.call(this, value);
    });
    try {
      headers = parser.parseHeaders();
    } finally {
      spy.mockRestore();
      parser.destroy();
    }
    expect(headers.map((h) => h.key)).toEqual(['from', 'to', 'subject']);
    expect(headers[1].line).toBe(['To: first@example.invalid,', ...continuations].join('\n'));
    expect(classifiedBytes).toBeLessThanOrEqual(Buffer.byteLength(input, 'latin1') * 2);
  },
);

it.each(edges)(
  'installed %s DKIM stream preserves folded header and binary body bytes',
  async (_name, require) => {
    const Parser = parserFor(require),
      parser = new Parser();
    const body = Buffer.from([0, 1, 255, 10]);
    const chunks = [];
    let headers;
    parser.on('headers', (value) => {
      headers = value;
    });
    parser.on('data', (chunk) => {
      chunks.push(chunk);
    });
    try {
      await new Promise((resolve, reject) => {
        parser.once('end', resolve);
        parser.once('error', reject);
        parser.end(
          Buffer.concat([
            Buffer.from('X-Fixture: caf\xe9\r\n\tmore\r\nSubject: fixture\r\n\r\n', 'latin1'),
            body,
          ]),
        );
      });
      expect(headers).toEqual([
        { key: 'x-fixture', line: 'X-Fixture: caf\xe9\n\tmore' },
        { key: 'subject', line: 'Subject: fixture' },
      ]);
      expect(Buffer.concat(chunks)).toEqual(body);
    } finally {
      parser.destroy();
    }
  },
);
