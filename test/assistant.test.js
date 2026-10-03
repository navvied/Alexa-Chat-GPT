import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssistant } from '../src/assistant.js';
import { fakeChat, testConfig, testStore } from './helpers.js';

function setup({
  reply = (messages) => `answer to: ${messages.at(-1).content}`,
  delayMs = 0,
  keepsHistory = false,
  config = {},
  now,
} = {}) {
  const cfg = testConfig(config);
  const chat = fakeChat(reply, { delayMs, keepsHistory });
  const store = testStore(cfg, now);
  const assistant = createAssistant({ chat, store, config: cfg, now: () => new Date('2026-10-03T05:00:00Z') });
  return { assistant, chat, store };
}

test('a fast answer is returned and remembered for the next question', async () => {
  const { assistant, chat } = setup();
  assert.deepEqual(await assistant.ask('s', 'hello'), { status: 'answered', question: 'hello', answer: 'answer to: hello' });
  await assistant.ask('s', 'and then?');

  const [system, ...rest] = chat.calls[1].messages;
  assert.equal(system.role, 'system');
  assert.match(system.content, /Saturday, October 3, 2026 at 12:00 PM \(Asia\/Jakarta\)/);
  assert.deepEqual(rest, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'answer to: hello' },
    { role: 'user', content: 'and then?' },
  ]);
});

test('every call carries the speaker and a stable conversation id', async () => {
  const { assistant, chat } = setup();
  await assistant.ask('alexa:speaker-1', 'q1');
  await assistant.ask('alexa:speaker-1', 'q2');
  await assistant.ask('alexa:speaker-2', 'q3');
  assert.equal(chat.calls[0].speakerKey, 'alexa:speaker-1');
  assert.match(chat.calls[0].conversationId, /^alexa-[0-9a-f-]{36}$/);
  assert.equal(chat.calls[1].conversationId, chat.calls[0].conversationId);
  assert.notEqual(chat.calls[2].conversationId, chat.calls[0].conversationId);
});

test('a client that keeps its own history (Hermes) gets none from here', async () => {
  const { assistant, chat } = setup({ keepsHistory: true });
  await assistant.ask('s', 'q1');
  await assistant.ask('s', 'q2');
  assert.deepEqual(chat.calls[1].history, []);
  assert.equal(chat.calls[1].question, 'q2');
});

test('speakers do not share history', async () => {
  const { assistant, chat } = setup();
  await assistant.ask('a', 'secret of a');
  await assistant.ask('b', 'question of b');
  assert.equal(chat.calls[1].messages.length, 2);
});

test('the conversation ends after the idle time and a new one begins', async () => {
  let nowMs = Date.parse('2026-10-03T05:00:00Z');
  const { assistant, chat } = setup({ now: () => nowMs, config: { conversationIdleMs: 15 * 60_000 } });
  await assistant.ask('s', 'q1');
  nowMs += 14 * 60_000;
  await assistant.ask('s', 'q2');
  assert.equal(chat.calls[1].history.length, 2);
  nowMs += 16 * 60_000;
  await assistant.ask('s', 'q3');
  assert.equal(chat.calls[2].history.length, 0);
  assert.notEqual(chat.calls[2].conversationId, chat.calls[1].conversationId);
});

test('start over forgets the conversation', async () => {
  const { assistant, chat } = setup();
  await assistant.ask('s', 'q1');
  assistant.startOver('s');
  await assistant.ask('s', 'q2');
  assert.equal(chat.calls[1].history.length, 0);
  assert.notEqual(chat.calls[1].conversationId, chat.calls[0].conversationId);
});

test('a slow answer becomes pending, says "let me think" once, and is delivered on resume', async () => {
  const { assistant } = setup({ delayMs: 250, config: { answerDeadlineMs: 100, progressiveAfterMs: 20 } });
  let slow = 0;
  assert.deepEqual(await assistant.ask('s', 'hard one', { onSlow: () => { slow += 1; } }), { status: 'pending' });
  assert.equal(slow, 1);
  assert.equal(assistant.hasPending('s'), true);

  assert.deepEqual(await assistant.resume('s'), { status: 'pending' });
  assert.deepEqual(await assistant.resume('s'), { status: 'answered', question: 'hard one', answer: 'answer to: hard one' });
  assert.equal(assistant.hasPending('s'), false);
  assert.deepEqual(await assistant.resume('s'), { status: 'none' });
});

test('"let me think" is not sent when the answer is quick', async () => {
  const { assistant } = setup({ delayMs: 10, config: { progressiveAfterMs: 100 } });
  let slow = 0;
  await assistant.ask('s', 'easy', { onSlow: () => { slow += 1; } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(slow, 0);
});

test('a new question drops and cancels the unheard pending one, which never enters history', async () => {
  const { assistant, chat } = setup({ delayMs: 150, config: { answerDeadlineMs: 100 } });
  assert.equal((await assistant.ask('s', 'first')).status, 'pending');
  assert.equal(chat.calls[0].signal.aborted, false);

  const second = assistant.ask('s', 'second');
  assert.equal(chat.calls[0].signal.aborted, true);
  assert.equal((await second).status, 'pending');
  assert.equal((await assistant.resume('s')).answer, 'answer to: second');

  await assistant.ask('s', 'third');
  const contents = chat.calls.at(-1).messages.slice(1).map((m) => m.content);
  assert.deepEqual(contents, ['second', 'answer to: second', 'third']);
});

test('cancelling the pending answer keeps the conversation', async () => {
  const { assistant, chat } = setup({ delayMs: 200, config: { answerDeadlineMs: 20 } });
  await assistant.ask('s', 'quick context', { onSlow: null });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await assistant.resume('s')).status, 'answered');

  await assistant.ask('s', 'long one');
  assistant.cancelPending('s');
  assert.equal(chat.calls[1].signal.aborted, true);
  assert.deepEqual(await assistant.resume('s'), { status: 'none' });
  assert.equal(chat.calls[1].conversationId, chat.calls[0].conversationId);
});

test('a failed answer throws and is not remembered', async () => {
  let fail = true;
  const { assistant, chat } = setup({
    reply: () => {
      if (fail) throw new Error('upstream down');
      return 'ok';
    },
  });
  await assert.rejects(assistant.ask('s', 'q1'), /upstream down/);
  fail = false;
  await assistant.ask('s', 'q2');
  assert.equal(chat.calls[1].messages.length, 2);
  assert.equal(assistant.hasPending('s'), false);
});

test('history keeps only the most recent turns', async () => {
  const { assistant, chat } = setup({ config: { maxHistoryTurns: 2 } });
  for (const q of ['q1', 'q2', 'q3', 'q4']) await assistant.ask('s', q);
  const contents = chat.calls.at(-1).messages.slice(1).map((m) => m.content);
  assert.deepEqual(contents, ['q2', 'answer to: q2', 'q3', 'answer to: q3', 'q4']);
});
