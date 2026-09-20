import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'node:http';
import { createMailSink } from './mail-sink.mjs';

const sinks = [];
afterEach(async () => {
  await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

describe('local mail inspection boundary', () => {
  it('allows loopback inspection but rejects rebinding Host and cross-site requests', async () => {
    const sink = await createMailSink();
    sinks.push(sink);
    sink.messages.push({
      receivedAt: Date.now(),
      to: ['test@ctp.invalid'],
      raw: 'mail-secret-canary',
    });
    const base = `http://127.0.0.1:${sink.httpPort}`;
    const local = await fetch(base + '/messages');
    expect(local.status).toBe(200);
    expect(await local.text()).toContain('mail-secret-canary');
    for (const headers of [
      { host: `attacker.invalid:${sink.httpPort}` },
      { origin: 'https://attacker.invalid' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      // fetch normalizes forbidden headers; raw HTTP is needed to exercise Host spoofing.
      const response = await new Promise((resolve, reject) => {
        const request = get(base + '/messages', { headers }, (reply) => {
          let body = '';
          reply.setEncoding('utf8');
          reply.on('data', (chunk) => {
            body += chunk;
          });
          reply.once('end', () =>
            resolve({ status: reply.statusCode, headers: reply.headers, body }),
          );
        });
        request.once('error', reject);
      });
      expect(response.status).toBe(403);
      expect(response.body).not.toContain('mail-secret-canary');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});
