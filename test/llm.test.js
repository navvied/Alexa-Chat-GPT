import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createChatClient } from '../src/llm.js';

let server;
let base;
let respond = () => {};
const received = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      respond(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

const json = (status, body) => (res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const client = (options = {}) =>
  createChatClient({ baseUrl: base, apiKey: 'sk-test', model: 'chat-latest', maxOutputTokens: 600, timeoutMs: 2_000, ...options });

test('sends an OpenAI Chat Completions request and returns the reply', async () => {
  received.length = 0;
  respond = json(200, { choices: [{ message: { content: '  Hello there.  ' }, finish_reason: 'stop' }] });
  const history = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }];
  const reply = await client({ reasoningEffort: 'low', temperature: 0.5 }).reply({ system: 'Be brief.', history, question: 'hi' });
  assert.equal(reply, 'Hello there.');

  const [request] = received;
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(request.body, {
    model: 'chat-latest',
    messages: [{ role: 'system', content: 'Be brief.' }, ...history, { role: 'user', content: 'hi' }],
    max_completion_tokens: 600,
    temperature: 0.5,
    reasoning_effort: 'low',
  });
});

test('leaves out optional fields and the key when not configured', async () => {
  received.length = 0;
  respond = json(200, { choices: [{ message: { content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }] } }] });
  const reply = await client({ apiKey: '', maxOutputTokens: undefined }).reply({ system: 's', question: 'hi' });
  assert.equal(reply, 'Part one. Part two.');
  assert.equal(received[0].headers.authorization, undefined);
  assert.deepEqual(Object.keys(received[0].body), ['model', 'messages']);
});

test('reports HTTP errors with the status and a hint', async () => {
  respond = json(401, { error: { message: 'Incorrect API key provided' } });
  await assert.rejects(client().reply({ system: 's', question: 'q' }), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /HTTP 401 \(check OPENAI_API_KEY\): .*Incorrect API key/);
    return true;
  });
});

test('reports an empty reply with its finish reason', async () => {
  respond = json(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  await assert.rejects(client().reply({ system: 's', question: 'q' }), /empty \(finish_reason: length\)/);
});

test('gives up after the timeout', async () => {
  respond = () => {}; // never answers
  await assert.rejects(client({ timeoutMs: 1_000 }).reply({ system: 's', question: 'q' }), /no reply within 1000 ms/);
});

test('can be cancelled', async () => {
  respond = () => {};
  const controller = new AbortController();
  const pending = client().reply({ system: 's', question: 'q', signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /cancelled/);
});
