import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createSign } from 'node:crypto';
import { createServer } from '../src/server.js';
import { createRequestVerifier } from '../src/verify.js';
import { silentLog } from '../src/log.js';
import { chatIntent, fixture, testConfig } from './helpers.js';

const CERT_URL = 'https://s3.amazonaws.com/echo.api/echo-api-cert-test.pem';
const handled = [];
let server;
let base;

before(async () => {
  const verifier = createRequestVerifier({
    fetchPem: async () => fixture('chain-valid.pem'),
    trustedRoots: [new X509Certificate(fixture('test-root.pem'))],
  });
  const handler = {
    async handle(envelope) {
      handled.push(envelope);
      return { version: '1.0', response: { shouldEndSession: true } };
    },
  };
  server = createServer({ config: testConfig(), handler, verifier, log: silentLog });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function signedPost(body, { signature, path = '/alexa' } = {}) {
  const sig = signature ?? createSign('RSA-SHA256').update(body).sign(fixture('signing-key.pem'), 'base64');
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', signaturecertchainurl: CERT_URL, 'signature-256': sig },
    body,
  });
}

test('a signed, current request for this skill is handled', async () => {
  handled.length = 0;
  const res = await signedPost(JSON.stringify(chatIntent('hello')));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: '1.0', response: { shouldEndSession: true } });
  assert.equal(handled.length, 1);
});

test('an unsigned request is rejected', async () => {
  const res = await fetch(`${base}/alexa`, { method: 'POST', body: JSON.stringify(chatIntent('hello')) });
  assert.equal(res.status, 400);
});

test('a request whose body was changed after signing is rejected', async () => {
  const signature = createSign('RSA-SHA256').update('{"original":true}').sign(fixture('signing-key.pem'), 'base64');
  const res = await signedPost(JSON.stringify(chatIntent('hello')), { signature });
  assert.equal(res.status, 400);
});

test('a replayed (old) request is rejected', async () => {
  const old = chatIntent('hello', { timestamp: new Date(Date.now() - 10 * 60_000) });
  const res = await signedPost(JSON.stringify(old));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /too far/);
});

test('a request for another skill is refused', async () => {
  handled.length = 0;
  const res = await signedPost(JSON.stringify(chatIntent('hello', { applicationId: 'amzn1.ask.skill.someone-else' })));
  assert.equal(res.status, 403);
  assert.equal(handled.length, 0);
});

test('a body that is too large is refused', async () => {
  const res = await signedPost('x'.repeat(300 * 1024));
  assert.equal(res.status, 413);
});

test('health check, unknown paths and wrong methods', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/alexa`)).status, 405);
});

test('with verification switched off, the skill id is still enforced', async () => {
  const handler = { handle: async () => ({ version: '1.0', response: {} }) };
  const open = createServer({ config: testConfig({ verifyRequests: false }), handler, verifier: null, log: silentLog });
  await new Promise((resolve) => open.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${open.address().port}/alexa`;
  try {
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(chatIntent('hi')) })).status, 200);
    const foreign = chatIntent('hi', { applicationId: 'amzn1.ask.skill.someone-else' });
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(foreign) })).status, 403);
  } finally {
    await new Promise((resolve) => open.close(resolve));
  }
});
