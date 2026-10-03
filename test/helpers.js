import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { ConversationStore } from '../src/conversations.js';

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

export function testStore(config, now) {
  return new ConversationStore({
    maxHistoryTurns: config.maxHistoryTurns,
    idleMs: config.conversationIdleMs,
    maxConversations: config.maxConversations,
    now,
  });
}

let counter = 0;

export function envelope(
  request,
  { sessionId = 'session-1', userId = 'user-1', personId, applicationId = SKILL_ID, timestamp = new Date() } = {},
) {
  counter += 1;
  const system = {
    application: { applicationId },
    user: { userId },
    apiEndpoint: 'https://api.amazonalexa.com',
    apiAccessToken: 'alexa-token',
  };
  if (personId) system.person = { personId };
  return {
    version: '1.0',
    session: { new: false, sessionId, application: { applicationId }, user: { userId } },
    context: { System: system },
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

/**
 * A fake chat client: answers come from `reply(messages, call)`, optionally after `delayMs`.
 * Each call records the arguments and the messages an OpenAI client would have sent.
 */
export function fakeChat(reply, { delayMs = 0, keepsHistory = false } = {}) {
  const calls = [];
  return {
    calls,
    keepsHistory,
    async reply(args) {
      const messages = [{ role: 'system', content: args.system }, ...args.history, { role: 'user', content: args.question }];
      const call = { ...args, messages };
      calls.push(call);
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          args.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      }
      return reply(messages, call);
    },
  };
}

export const speechText = (response) =>
  response.response.outputSpeech.ssml.replace(/^<speak>|<\/speak>$/g, '');
