// The HTTP endpoint Alexa calls. It accepts only verified requests for this skill.

import http from 'node:http';
import { verifyTimestamp } from './verify.js';

const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop keeping the body but drain it, so the 413 can still be sent.
        req.off('data', onData);
        req.resume();
        reject(new HttpError(413, 'request body too large'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * @param {object} deps
 * @param {{ handle(envelope: object): Promise<object> }} deps.handler
 * @param {{ verify(rawBody: Buffer, headers: object): Promise<void> }} deps.verifier
 */
export function createServer({ config, handler, verifier, log }) {
  async function handleAlexa(req, res) {
    const raw = await readBody(req);

    if (config.verifyRequests) {
      try {
        await verifier.verify(raw, req.headers);
      } catch (error) {
        throw new HttpError(400, `signature check failed: ${error.message}`);
      }
    }

    let envelope;
    try {
      envelope = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'body is not valid JSON');
    }

    if (config.verifyRequests) {
      try {
        verifyTimestamp(envelope);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    }

    const applicationId = envelope?.context?.System?.application?.applicationId
      ?? envelope?.session?.application?.applicationId;
    if (applicationId !== config.skillId) throw new HttpError(403, 'request is for a different skill');

    send(res, 200, await handler.handle(envelope));
  }

  return http.createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (path === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
      if (path !== config.path) throw new HttpError(404, 'not found');
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      await handleAlexa(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) log.error('request failed', { error: error.stack ?? String(error) });
      else if (status !== 404) log.warn('request rejected', { status, reason: error.message });
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'internal error' : error.message });
    }
  });
}
