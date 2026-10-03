import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createSign } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import {
  createRequestVerifier,
  normalizeCertUrl,
  parsePemChain,
  validateChain,
  verifyTimestamp,
} from '../src/verify.js';
import { fixture } from './helpers.js';

const CERT_URL = 'https://s3.amazonaws.com/echo.api/echo-api-cert-test.pem';
const testRoot = new X509Certificate(fixture('test-root.pem'));
const mozillaRoots = rootCertificates.map((pem) => new X509Certificate(pem));

function sign(body, key = fixture('signing-key.pem')) {
  return createSign('RSA-SHA256').update(body).sign(key, 'base64');
}

function verifierFor(chainFile, options = {}) {
  const fetched = [];
  const verifier = createRequestVerifier({
    fetchPem: async (url) => {
      fetched.push(url);
      return fixture(chainFile);
    },
    trustedRoots: [testRoot],
    ...options,
  });
  return { verifier, fetched };
}

const headers = (signature, url = CERT_URL) => ({ signaturecertchainurl: url, 'signature-256': signature });

test('certificate URL: accepts the forms Amazon documents as valid', () => {
  assert.equal(
    normalizeCertUrl('https://s3.amazonaws.com/echo.api/echo-api-cert.pem'),
    'https://s3.amazonaws.com/echo.api/echo-api-cert.pem',
  );
  assert.equal(
    normalizeCertUrl('https://s3.amazonaws.com:443/echo.api/echo-api-cert.pem'),
    'https://s3.amazonaws.com/echo.api/echo-api-cert.pem',
  );
  assert.equal(
    normalizeCertUrl('https://s3.amazonaws.com/echo.api/../echo.api/echo-api-cert.pem'),
    'https://s3.amazonaws.com/echo.api/echo-api-cert.pem',
  );
  assert.equal(
    normalizeCertUrl('HTTPS://S3.AMAZONAWS.COM/echo.api/echo-api-cert.pem'),
    'https://s3.amazonaws.com/echo.api/echo-api-cert.pem',
  );
});

test('certificate URL: rejects the forms Amazon documents as invalid', () => {
  for (const url of [
    'http://s3.amazonaws.com/echo.api/echo-api-cert.pem',
    'https://notamazon.com/echo.api/echo-api-cert.pem',
    'https://s3.amazonaws.com/EcHo.aPi/echo-api-cert.pem',
    'https://s3.amazonaws.com/invalid.path/echo-api-cert.pem',
    'https://s3.amazonaws.com:563/echo.api/echo-api-cert.pem',
    'https://s3.amazonaws.com/echo.api/../invalid.path/echo-api-cert.pem',
    'https://s3.amazonaws.com.evil.example/echo.api/echo-api-cert.pem',
    'https://user:pass@s3.amazonaws.com/echo.api/echo-api-cert.pem',
    'not a url',
  ]) {
    assert.throws(() => normalizeCertUrl(url), /certificate URL/, url);
  }
});

test('chain: Amazon\'s real signing chain validates against the system roots while it was current', () => {
  const chain = parsePemChain(fixture('echo-api-cert-12.pem'));
  assert.equal(chain.length, 4);
  validateChain(chain, mozillaRoots, Date.parse('2023-06-01T00:00:00Z'));
});

test('chain: Amazon\'s real signing chain is rejected once expired', () => {
  const chain = parsePemChain(fixture('echo-api-cert-12.pem'));
  assert.throws(() => validateChain(chain, mozillaRoots, Date.parse('2026-01-01T00:00:00Z')), /expired/);
});

test('chain: rejects a chain that does not reach a trusted root', () => {
  const chain = parsePemChain(fixture('chain-valid.pem'));
  assert.throws(() => validateChain(chain, mozillaRoots, Date.now()), /trusted root/);
});

test('chain: rejects a leaf that does not name echo-api.amazon.com', () => {
  const chain = parsePemChain(fixture('chain-wrong-san.pem'));
  assert.throws(() => validateChain(chain, [testRoot], Date.now()), /echo-api\.amazon\.com/);
});

test('chain: rejects a chain with the intermediate missing', () => {
  const chain = parsePemChain(fixture('chain-missing-intermediate.pem'));
  assert.throws(() => validateChain(chain, [testRoot], Date.now()), /trusted root/);
});

test('chain: rejects an issuer that is not a CA', () => {
  const chain = parsePemChain(fixture('chain-not-ca-issuer.pem'));
  assert.throws(() => validateChain(chain, [testRoot], Date.now()), /non-CA/);
});

test('chain: rejects an empty or garbage chain', () => {
  assert.throws(() => parsePemChain(''), /empty/);
  assert.throws(
    () => parsePemChain('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'),
    /could not be parsed/,
  );
});

test('signature: accepts a correctly signed body', async () => {
  const body = Buffer.from('{"hello":"alexa"}');
  const { verifier, fetched } = verifierFor('chain-valid.pem');
  await verifier.verify(body, headers(sign(body)));
  assert.deepEqual(fetched, [CERT_URL]);
});

test('signature: rejects a body changed after signing', async () => {
  const signature = sign(Buffer.from('{"hello":"alexa"}'));
  const { verifier } = verifierFor('chain-valid.pem');
  await assert.rejects(verifier.verify(Buffer.from('{"hello":"attacker"}'), headers(signature)), /does not match/);
});

test('signature: rejects a body signed with another key', async () => {
  const body = Buffer.from('{"hello":"alexa"}');
  const { verifier } = verifierFor('chain-valid.pem');
  await assert.rejects(verifier.verify(body, headers(sign(body, fixture('other-key.pem')))), /does not match/);
});

test('signature: rejects missing headers and bad URLs before downloading anything', async () => {
  const body = Buffer.from('{}');
  const { verifier, fetched } = verifierFor('chain-valid.pem');
  await assert.rejects(verifier.verify(body, {}), /SignatureCertChainUrl/);
  await assert.rejects(verifier.verify(body, { signaturecertchainurl: CERT_URL }), /Signature-256/);
  await assert.rejects(verifier.verify(body, headers(sign(body), 'https://evil.example/echo.api/x.pem')), /wrong host/);
  assert.deepEqual(fetched, []);
});

test('signature: caches the chain, and still rejects it once the leaf has expired', async () => {
  const body = Buffer.from('{}');
  let nowMs = Date.now();
  const { verifier, fetched } = verifierFor('chain-valid.pem', { now: () => nowMs });
  await verifier.verify(body, headers(sign(body)));
  await verifier.verify(body, headers(sign(body)));
  assert.equal(fetched.length, 1);

  nowMs = Date.parse('2200-01-01T00:00:00Z');
  await assert.rejects(verifier.verify(body, headers(sign(body))), /expired/);
});

test('timestamp: accepts within 150 seconds either way, rejects beyond', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const at = (offsetMs) => ({ request: { timestamp: new Date(now + offsetMs).toISOString() } });
  verifyTimestamp(at(0), now);
  verifyTimestamp(at(-149_000), now);
  verifyTimestamp(at(149_000), now);
  assert.throws(() => verifyTimestamp(at(-151_000), now), /too far/);
  assert.throws(() => verifyTimestamp(at(151_000), now), /too far/);
  assert.throws(() => verifyTimestamp({ request: {} }, now), /no valid timestamp/);
});
