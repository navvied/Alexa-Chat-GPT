import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SYSTEM_PROMPT, loadConfig } from '../src/config.js';
import { SKILL_ID } from './helpers.js';

test('defaults are sensible with only the required settings', () => {
  const config = loadConfig({ ALEXA_SKILL_ID: SKILL_ID, OPENAI_API_KEY: 'sk-test' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.path, '/alexa');
  assert.equal(config.verifyRequests, true);
  assert.equal(config.openai.model, 'chat-latest');
  assert.equal(config.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.openai.maxOutputTokens, 600);
  assert.equal(config.openai.temperature, undefined);
  assert.equal(config.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  assert.equal(config.answerDeadlineMs, 6_000);
  assert.equal(config.sessionIdleMs, 30 * 60_000);
});

test('lists every problem at once', () => {
  assert.throws(
    () => loadConfig({ PORT: 'abc', ANSWER_DEADLINE_MS: '9000', TIMEZONE: 'Mars/Base', ALEXA_SKIP_VERIFICATION: 'maybe' }),
    (error) => {
      for (const name of ['ALEXA_SKILL_ID', 'OPENAI_API_KEY', 'PORT', 'ANSWER_DEADLINE_MS', 'TIMEZONE', 'ALEXA_SKIP_VERIFICATION']) {
        assert.match(error.message, new RegExp(name));
      }
      return true;
    },
  );
});

test('a self-hosted OpenAI-compatible server needs no key', () => {
  const config = loadConfig({ ALEXA_SKILL_ID: SKILL_ID, OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1/' });
  assert.equal(config.openai.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(config.openai.apiKey, '');
});

test('a token limit of 0 means no limit, and \\n in the prompt becomes a new line', () => {
  const config = loadConfig({
    ALEXA_SKILL_ID: SKILL_ID,
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MAX_OUTPUT_TOKENS: '0',
    SYSTEM_PROMPT: 'Line one.\\nLine two.',
  });
  assert.equal(config.openai.maxOutputTokens, undefined);
  assert.equal(config.systemPrompt, 'Line one.\nLine two.');
});

test('rejects a skill id that is not one', () => {
  assert.throws(() => loadConfig({ ALEXA_SKILL_ID: 'my-skill', OPENAI_API_KEY: 'sk' }), /must start with amzn1\.ask\.skill\./);
});
