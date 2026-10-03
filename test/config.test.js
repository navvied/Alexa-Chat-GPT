import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SYSTEM_PROMPTS, SAFE_HERMES_TOOLS, loadConfig } from '../src/config.js';
import { SKILL_ID } from './helpers.js';

const hermesEnv = (extra = {}) => ({
  ALEXA_SKILL_ID: SKILL_ID,
  CHAT_PROVIDER: 'hermes',
  HERMES_BASE_URL: 'http://127.0.0.1:8650/v1',
  HERMES_API_KEY: 'hermes-key',
  ...extra,
});

test('defaults are sensible with only the required settings', () => {
  const config = loadConfig({ ALEXA_SKILL_ID: SKILL_ID, OPENAI_API_KEY: 'sk-test' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.path, '/alexa');
  assert.equal(config.verifyRequests, true);
  assert.equal(config.provider, 'openai');
  assert.equal(config.openai.model, 'chat-latest');
  assert.equal(config.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.openai.maxOutputTokens, 600);
  assert.equal(config.openai.temperature, undefined);
  assert.equal(config.hermes, undefined);
  assert.equal(config.systemPrompt, DEFAULT_SYSTEM_PROMPTS.openai);
  assert.equal(config.answerDeadlineMs, 6_000);
  assert.equal(config.conversationIdleMs, 15 * 60_000);
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

test('rejects a skill id that is not one, and an unknown provider', () => {
  assert.throws(() => loadConfig({ ALEXA_SKILL_ID: 'my-skill', OPENAI_API_KEY: 'sk' }), /must start with amzn1\.ask\.skill\./);
  assert.throws(() => loadConfig({ ALEXA_SKILL_ID: SKILL_ID, CHAT_PROVIDER: 'gemini' }), /CHAT_PROVIDER must be openai or hermes/);
});

test('hermes: needs a URL and a key, and needs no OpenAI settings', () => {
  const config = loadConfig(hermesEnv());
  assert.equal(config.provider, 'hermes');
  assert.equal(config.openai, undefined);
  assert.deepEqual(config.hermes, {
    baseUrl: 'http://127.0.0.1:8650/v1',
    apiKey: 'hermes-key',
    model: 'hermes-agent',
    timeoutMs: 120_000,
    allowedTools: SAFE_HERMES_TOOLS,
  });
  assert.equal(config.systemPrompt, DEFAULT_SYSTEM_PROMPTS.hermes);

  assert.throws(
    () => loadConfig({ ALEXA_SKILL_ID: SKILL_ID, CHAT_PROVIDER: 'hermes' }),
    (error) => /HERMES_BASE_URL is required/.test(error.message) && /HERMES_API_KEY is required/.test(error.message),
  );
});

test('hermes: the key never travels over plain HTTP to another machine', () => {
  assert.throws(() => loadConfig(hermesEnv({ HERMES_BASE_URL: 'http://hermes.navvied.com/v1' })), /must use https/);
  assert.equal(loadConfig(hermesEnv({ HERMES_BASE_URL: 'https://hermes.navvied.com/v1' })).hermes.baseUrl, 'https://hermes.navvied.com/v1');
  assert.equal(loadConfig(hermesEnv({ HERMES_BASE_URL: 'http://localhost:8650/v1' })).hermes.baseUrl, 'http://localhost:8650/v1');
});

test('hermes: extra tools are added to the safe list only when named', () => {
  const config = loadConfig(hermesEnv({ HERMES_EXTRA_TOOLS: ' ha_get_state , ha_call_service ,' }));
  assert.deepEqual(config.hermes.allowedTools, [...SAFE_HERMES_TOOLS, 'ha_get_state', 'ha_call_service']);
});
