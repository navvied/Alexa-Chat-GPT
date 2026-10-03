import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHermesClient, findUnsafeTools, responseText, UnsafeToolsError } from '../src/hermes.js';
import { SAFE_HERMES_TOOLS } from '../src/config.js';

// A stand-in for a Hermes API server: /v1/toolsets and /v1/responses.
let server;
let base;
let toolsets;
let respond;
const received = [];

const SAFE_TOOLSETS = [
  { name: 'web', enabled: true, configured: true, tools: ['web_search', 'web_extract'] },
  { name: 'memory', enabled: true, configured: true, tools: ['memory'] },
  { name: 'session_search', enabled: true, configured: true, tools: ['session_search'] },
  { name: 'terminal', enabled: false, configured: true, tools: ['terminal', 'process_manage'] },
];

const answer = (text, extra = {}) => ({
  id: 'resp_1',
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'function_call', name: 'web_search', status: 'completed' },
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Searching the web…' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  ],
  ...extra,
});

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.headers.authorization !== 'Bearer hermes-key') {
        res.writeHead(401).end('{"error":"unauthorized"}');
      } else if (req.url === '/v1/toolsets') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(toolsets));
      } else if (req.url === '/v1/responses') {
        respond(res);
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received.length = 0;
  toolsets = SAFE_TOOLSETS;
  respond = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer('It is sunny in Jakarta.')));
});

const client = (options = {}, now) =>
  createHermesClient(
    { baseUrl: base, apiKey: 'hermes-key', model: 'hermes-agent', timeoutMs: 2_000, allowedTools: SAFE_HERMES_TOOLS, ...options },
    fetch,
    now,
  );

const ask = (c, extra = {}) =>
  c.reply({ system: 'Speak briefly.', question: 'weather in jakarta?', conversationId: 'alexa-abc', speakerKey: 'alexa:123', ...extra });

test('sends only the new question, in a named conversation, with the speaker as memory scope', async () => {
  assert.equal(await ask(client()), 'It is sunny in Jakarta.');
  const request = received.find((r) => r.path === '/v1/responses');
  assert.equal(request.headers['x-hermes-session-key'], 'alexa:123');
  assert.deepEqual(request.body, {
    model: 'hermes-agent',
    input: 'weather in jakarta?',
    instructions: 'Speak briefly.',
    conversation: 'alexa-abc',
    stream: false,
  });
});

test('checks the tools before the first question, then at most every five minutes', async () => {
  let nowMs = 0;
  const c = client({}, () => nowMs);
  await ask(c);
  await ask(c);
  assert.equal(received.filter((r) => r.path === '/v1/toolsets').length, 1);
  nowMs += 5 * 60_000 + 1;
  await ask(c);
  assert.equal(received.filter((r) => r.path === '/v1/toolsets').length, 2);
});

test('refuses to answer while Hermes exposes a tool that voice must not reach', async () => {
  toolsets = [...SAFE_TOOLSETS, { name: 'terminal', enabled: true, configured: true, tools: ['terminal', 'process_manage'] }];
  await assert.rejects(ask(client()), (error) => {
    assert.ok(error instanceof UnsafeToolsError);
    assert.deepEqual(error.tools, ['terminal (terminal)', 'process_manage (terminal)']);
    assert.match(error.message, /agent\.disabled_toolsets/);
    return true;
  });
  assert.equal(received.filter((r) => r.path === '/v1/responses').length, 0);
});

test('a tool named in HERMES_EXTRA_TOOLS is allowed on purpose', async () => {
  toolsets = [...SAFE_TOOLSETS, { name: 'homeassistant', enabled: true, tools: ['ha_get_state'] }];
  await assert.rejects(ask(client()), UnsafeToolsError);
  assert.equal(await ask(client({ allowedTools: [...SAFE_HERMES_TOOLS, 'ha_get_state'] })), 'It is sunny in Jakarta.');
});

test('unsafe tools: a toolset without a tool list counts as unsafe; disabled ones do not count', () => {
  assert.deepEqual(findUnsafeTools([{ name: 'mystery', enabled: true }], SAFE_HERMES_TOOLS), ['mystery (toolset)']);
  assert.deepEqual(findUnsafeTools([{ name: 'file', enabled: false, tools: ['write_file'] }], SAFE_HERMES_TOOLS), []);
  assert.deepEqual(findUnsafeTools([{ name: 'core', tools: ['web_search', 'write_file'] }], SAFE_HERMES_TOOLS), ['write_file (core)']);
});

test('a wrong key or URL is reported as such', async () => {
  await assert.rejects(ask(client({ apiKey: 'wrong' })), (error) => error.status === 401 && /HERMES_API_KEY/.test(error.message));
  await assert.rejects(ask(client({ baseUrl: base.replace('/v1', '/nope') })), (error) => error.status === 404 && /HERMES_BASE_URL/.test(error.message));
});

test('a failure written as answer text is not read aloud', async () => {
  respond = (res) => res.writeHead(200).end(JSON.stringify(answer('\u26A0\uFE0F Provider authentication failed: run hermes model')));
  await assert.rejects(ask(client()), /Hermes reported a problem/);
});

test('a failed run is reported', async () => {
  respond = (res) => res.writeHead(200).end(JSON.stringify({ status: 'failed', error: { message: 'usage limit reached' }, output: [] }));
  await assert.rejects(ask(client()), /Hermes run failed: usage limit reached/);
});

test('the answer is the last message that is not commentary', () => {
  assert.equal(responseText(answer('Final.')), 'Final.');
  assert.equal(responseText({ output: [] }), '');
  assert.equal(responseText({ output_text: ' Fallback. ' }), 'Fallback.');
  assert.equal(
    responseText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'A ' }, { type: 'output_text', text: 'B' }] }] }),
    'A B',
  );
});

test('can be cancelled, and gives up after the timeout', async () => {
  respond = () => {}; // never answers
  const controller = new AbortController();
  const pending = ask(client(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(ask(client({ timeoutMs: 1_000 })), /no reply within 1000 ms/);
});
