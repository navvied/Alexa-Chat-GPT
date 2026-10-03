// Verifies that a request really comes from Alexa, as Amazon requires for skills hosted on
// your own web service:
// https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html
//
// Built on Node's own crypto (OpenSSL) on purpose: the official ask-sdk-express-adapter
// validates the certificate chain with node-forge, which has an unfixed advisory in exactly
// that code path (GHSA-86w9-cpqp-85rv).

import { X509Certificate, verify as verifySignature } from 'node:crypto';
import { rootCertificates } from 'node:tls';

const CERT_HOST = 's3.amazonaws.com';
const CERT_PATH_PREFIX = '/echo.api/';
const SIGNING_DOMAIN = 'echo-api.amazon.com';
const TIMESTAMP_TOLERANCE_MS = 150_000;
const CERT_CACHE_TTL_MS = 60 * 60 * 1000;
const CERT_CACHE_MAX = 16;
const CERT_MAX_BYTES = 64 * 1024;
const CERT_FETCH_TIMEOUT_MS = 5_000;

export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationError';
  }
}

/**
 * Checks the SignatureCertChainUrl header and returns the normalized URL to download.
 * The WHATWG URL parser lower-cases the scheme and host, drops the default port and
 * resolves dot segments, which is exactly the normalization Amazon asks for.
 */
export function normalizeCertUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new VerificationError('certificate URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new VerificationError('certificate URL must use https');
  if (url.hostname !== CERT_HOST) throw new VerificationError('certificate URL has the wrong host');
  if (url.port !== '' && url.port !== '443') throw new VerificationError('certificate URL has the wrong port');
  if (!url.pathname.startsWith(CERT_PATH_PREFIX)) throw new VerificationError('certificate URL has the wrong path');
  if (url.username || url.password) throw new VerificationError('certificate URL must not carry credentials');
  return url.href;
}

export function parsePemChain(pem) {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new VerificationError('certificate chain is empty');
  try {
    return blocks.map((block) => new X509Certificate(block));
  } catch {
    throw new VerificationError('certificate chain could not be parsed');
  }
}

function isCurrent(cert, nowMs) {
  return Date.parse(cert.validFrom) <= nowMs && nowMs <= Date.parse(cert.validTo);
}

function hasSigningDomain(cert) {
  return (cert.subjectAltName ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .includes(`DNS:${SIGNING_DOMAIN}`);
}

function issuedBy(cert, issuer) {
  return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
}

/**
 * Validates a parsed chain: the leaf is current and names echo-api.amazon.com, and every
 * link up to a trusted root is a current CA certificate that really signed the one below it.
 */
export function validateChain(chain, trustedRoots, nowMs) {
  const [leaf] = chain;
  if (!isCurrent(leaf, nowMs)) throw new VerificationError('signing certificate is expired or not yet valid');
  if (!hasSigningDomain(leaf)) throw new VerificationError(`signing certificate does not name ${SIGNING_DOMAIN}`);

  const isTrusted = (cert) => trustedRoots.some((root) => root.fingerprint256 === cert.fingerprint256);
  const trustedIssuerOf = (cert) =>
    trustedRoots.find((root) => isCurrent(root, nowMs) && issuedBy(cert, root));

  let current = leaf;
  for (let i = 1; ; i += 1) {
    if (trustedIssuerOf(current)) return;
    const issuer = chain[i];
    if (!issuer) throw new VerificationError('certificate chain does not reach a trusted root');
    if (!issuer.ca) throw new VerificationError('certificate chain contains a non-CA issuer');
    if (!isCurrent(issuer, nowMs)) throw new VerificationError('certificate chain contains an expired certificate');
    if (!issuedBy(current, issuer)) throw new VerificationError('certificate chain is broken');
    if (isTrusted(issuer)) return;
    current = issuer;
  }
}

/** Checks that the request was made within 150 seconds of now, in either direction. */
export function verifyTimestamp(envelope, nowMs = Date.now()) {
  const timestamp = Date.parse(envelope?.request?.timestamp ?? '');
  if (Number.isNaN(timestamp)) throw new VerificationError('request has no valid timestamp');
  if (Math.abs(nowMs - timestamp) > TIMESTAMP_TOLERANCE_MS) {
    throw new VerificationError('request timestamp is too far from the current time');
  }
}

async function fetchCertChain(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new VerificationError(`certificate download failed with status ${res.status}`);
  const body = await res.text();
  if (body.length > CERT_MAX_BYTES) throw new VerificationError('certificate chain is too large');
  return body;
}

export function createRequestVerifier({
  fetchPem = fetchCertChain,
  trustedRoots = rootCertificates.map((pem) => new X509Certificate(pem)),
  now = Date.now,
} = {}) {
  const cache = new Map();

  async function loadChain(url) {
    const cached = cache.get(url);
    if (cached && now() - cached.fetchedAt < CERT_CACHE_TTL_MS) return cached.chain;
    const chain = parsePemChain(await fetchPem(url));
    validateChain(chain, trustedRoots, now());
    cache.delete(url);
    cache.set(url, { chain, fetchedAt: now() });
    while (cache.size > CERT_CACHE_MAX) cache.delete(cache.keys().next().value);
    return chain;
  }

  return {
    /**
     * @param {Buffer} rawBody the request body exactly as received
     * @param {import('node:http').IncomingHttpHeaders} headers
     */
    async verify(rawBody, headers) {
      const certUrl = headers['signaturecertchainurl'];
      const signature = headers['signature-256'];
      if (typeof certUrl !== 'string' || !certUrl) throw new VerificationError('missing SignatureCertChainUrl header');
      if (typeof signature !== 'string' || !signature) throw new VerificationError('missing Signature-256 header');

      const chain = await loadChain(normalizeCertUrl(certUrl));
      // A cached chain was valid when fetched; its leaf may have expired since.
      if (!isCurrent(chain[0], now())) throw new VerificationError('signing certificate is expired or not yet valid');

      const ok = verifySignature('RSA-SHA256', rawBody, chain[0].publicKey, Buffer.from(signature, 'base64'));
      if (!ok) throw new VerificationError('signature does not match the request body');
    },
  };
}
