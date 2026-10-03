import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';

export const SKILL_ID = 'amzn1.ask.skill.11111111-2222-3333-4444-555555555555';

export const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export function testConfig(overrides = {}) {
  return {
    ...loadConfig({ ALEXA_SKILL_ID: SKILL_ID, OPENAI_API_KEY: 'test-key' }),
    answerDeadlineMs: 200,
    progressiveAfterMs: 50,
    ...overrides,
  };
}

let counter = 0;

export function envelope(request, { sessionId = 'session-1', applicationId = SKILL_ID, timestamp = new Date() } = {}) {
  counter += 1;
  return {
    version: '1.0',
    session: { new: false, sessionId, application: { applicationId }, user: { userId: 'user-1' } },
    context: {
      System: {
        application: { applicationId },
        user: { userId: 'user-1' },
        apiEndpoint: 'https://api.amazonalexa.com',
        apiAccessToken: 'alexa-token',
      },
    },
    request: { requestId: `request-${counter}`, timestamp: timestamp.toISOString(), locale: 'en-US', ...request },
  };
}

export const intent = (name, slots = {}, options) =>
  envelope(
    {
      type: 'IntentRequest',
      intent: {
        name,
        confirmationStatus: 'NONE',
        slots: Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, { name: key, value }])),
      },
    },
    options,
  );

export const chatIntent = (query, options) => intent('ChatIntent', { query }, options);

/** A fake chat client: answers come from `reply(messages)`, optionally after `delayMs`. */
export function fakeChat(reply, { delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async complete(messages, { signal } = {}) {
      calls.push({ messages, signal });
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      }
      return reply(messages);
    },
  };
}

export const speechText = (response) =>
  response.response.outputSpeech.ssml.replace(/^<speak>|<\/speak>$/g, '');
