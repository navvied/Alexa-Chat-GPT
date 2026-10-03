import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlexaHandler, createProgressiveSender, SPEECH } from '../src/alexa.js';
import { createAssistant } from '../src/assistant.js';
import { ConversationStore } from '../src/conversations.js';
import { silentLog } from '../src/log.js';
import { chatIntent, envelope, fakeChat, intent, speechText, testConfig } from './helpers.js';

function setup({ reply = () => 'Jakarta is the capital of **Indonesia**.', delayMs = 0, config = {} } = {}) {
  const cfg = testConfig(config);
  const chat = fakeChat(reply, { delayMs });
  const store = new ConversationStore({ maxHistoryTurns: cfg.maxHistoryTurns, idleMs: cfg.sessionIdleMs, maxSessions: cfg.maxSessions });
  const assistant = createAssistant({ chat, store, config: cfg });
  const spoken = [];
  const handler = createAlexaHandler({
    assistant,
    config: cfg,
    log: silentLog,
    progressive: (env, text) => spoken.push(text),
  });
  return { handler, chat, spoken };
}

test('launch greets and keeps the microphone open', async () => {
  const { handler } = setup();
  const res = await handler.handle(envelope({ type: 'LaunchRequest' }));
  assert.equal(speechText(res), SPEECH.launch);
  assert.equal(res.response.shouldEndSession, false);
  assert.ok(res.response.reprompt);
});

test('a question is answered aloud, with a card, and the session stays open', async () => {
  const { handler, chat } = setup();
  const res = await handler.handle(chatIntent('what is the capital of indonesia'));
  assert.equal(speechText(res), 'Jakarta is the capital of Indonesia.');
  assert.equal(res.response.card.type, 'Simple');
  assert.match(res.response.card.content, /^You: what is the capital of indonesia/);
  assert.equal(res.response.shouldEndSession, false);
  assert.equal(chat.calls[0].messages.at(-1).content, 'what is the capital of indonesia');
});

test('a slow answer asks the user to say continue, then ContinueIntent delivers it', async () => {
  const { handler, spoken } = setup({ delayMs: 150, config: { answerDeadlineMs: 100, progressiveAfterMs: 30 } });
  const first = await handler.handle(chatIntent('a hard question'));
  assert.equal(speechText(first), escape(SPEECH.pending));
  assert.deepEqual(spoken, [SPEECH.thinking]);

  const second = await handler.handle(intent('ContinueIntent'));
  assert.equal(speechText(second), 'Jakarta is the capital of Indonesia.');
});

test('"continue" caught by ChatIntent still delivers the pending answer instead of asking ChatGPT', async () => {
  const { handler, chat } = setup({ delayMs: 150, config: { answerDeadlineMs: 100 } });
  await handler.handle(chatIntent('a hard question'));
  const res = await handler.handle(chatIntent('Continue.'));
  assert.equal(speechText(res), 'Jakarta is the capital of Indonesia.');
  assert.equal(chat.calls.length, 1);
});

test('"yes" with nothing pending is just a question', async () => {
  const { handler, chat } = setup();
  await handler.handle(chatIntent('yes'));
  assert.equal(chat.calls.length, 1);
});

test('continue with nothing pending invites a question', async () => {
  const { handler } = setup();
  const res = await handler.handle(intent('AMAZON.YesIntent'));
  assert.equal(speechText(res), SPEECH.nothingPending);
});

test('an upstream failure is spoken as an apology, not an error from Alexa', async () => {
  const { handler } = setup({ reply: () => { throw new Error('HTTP 500'); } });
  const res = await handler.handle(chatIntent('anything'));
  assert.equal(speechText(res), escape(SPEECH.failed));
  assert.equal(res.response.shouldEndSession, false);
});

test('an empty query asks the user to repeat', async () => {
  const { handler, chat } = setup();
  const res = await handler.handle(intent('ChatIntent', {}));
  assert.equal(speechText(res), escape(SPEECH.notHeard));
  assert.equal(chat.calls.length, 0);
});

test('stop says goodbye, ends the session and forgets the conversation', async () => {
  const { handler, chat } = setup();
  await handler.handle(chatIntent('remember the number seven'));
  const res = await handler.handle(intent('AMAZON.StopIntent'));
  assert.equal(speechText(res), SPEECH.goodbye);
  assert.equal(res.response.shouldEndSession, true);

  await handler.handle(chatIntent('what number?'));
  assert.equal(chat.calls[1].messages.length, 2);
});

test('help, fallback and unknown intents get spoken answers', async () => {
  const { handler } = setup();
  assert.match(speechText(await handler.handle(intent('AMAZON.HelpIntent'))), /ask me anything/);
  assert.equal(speechText(await handler.handle(intent('AMAZON.FallbackIntent'))), escape(SPEECH.notHeard));
  assert.equal(speechText(await handler.handle(intent('SomethingNew'))), escape(SPEECH.notHeard));
});

test('SessionEndedRequest and other requests get an empty response', async () => {
  const { handler } = setup();
  assert.deepEqual(await handler.handle(envelope({ type: 'SessionEndedRequest', reason: 'USER_INITIATED' })), { version: '1.0', response: {} });
  assert.deepEqual(await handler.handle(envelope({ type: 'System.ExceptionEncountered', error: {} })), { version: '1.0', response: {} });
});

test('progressive responses go only to Amazon, with the request id', async () => {
  const sent = [];
  const send = createProgressiveSender({ log: silentLog, fetchImpl: async (url, init) => { sent.push({ url: String(url), init }); return { ok: true }; } });

  const env = envelope({ type: 'IntentRequest' });
  send(env, 'Let me think.');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.amazonalexa.com/v1/directives');
  assert.equal(sent[0].init.headers.authorization, 'Bearer alexa-token');
  assert.deepEqual(JSON.parse(sent[0].init.body), {
    header: { requestId: env.request.requestId },
    directive: { type: 'VoicePlayer.Speak', speech: '<speak>Let me think.</speak>' },
  });

  const forged = envelope({ type: 'IntentRequest' });
  forged.context.System.apiEndpoint = 'https://evil.example';
  send(forged, 'Let me think.');
  assert.equal(sent.length, 1);
});

function escape(text) {
  return text.replace(/'/g, '&apos;').replace(/"/g, '&quot;');
}
