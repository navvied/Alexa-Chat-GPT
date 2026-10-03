import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardText, escapeSsml, replySsml, toSpeechText, truncate } from '../src/speech.js';

test('escapes every character SSML treats specially', () => {
  assert.equal(escapeSsml(`Tom & Jerry <3 "quotes" it's`), 'Tom &amp; Jerry &lt;3 &quot;quotes&quot; it&apos;s');
});

test('strips markdown decoration but keeps the words', () => {
  const markdown = [
    '# Fried rice',
    'This is **really** easy and *quick*, with __no__ fuss.',
    '',
    '1. Heat the oil',
    '2. Add the rice',
    '- Serve hot',
    '> Tip: use day-old rice',
  ].join('\n');
  assert.equal(
    toSpeechText(markdown),
    'Fried rice. This is really easy and quick, with no fuss. Heat the oil. Add the rice. Serve hot. Tip: use day-old rice.',
  );
});

test('drops links, URLs, code and emoji', () => {
  const markdown = 'See [the docs](https://example.com) or visit https://example.com/x. 🚀 Now.\n```js\nconsole.log(1)\n```\nUse `npm test`.';
  assert.equal(
    toSpeechText(markdown),
    'See the docs or visit the link in your Alexa app. Now. (The code is in your Alexa app.) Use npm test.',
  );
});

test('keeps snake_case and arithmetic intact', () => {
  assert.equal(toSpeechText('Set max_tokens to 2*3*4.'), 'Set max_tokens to 2*3*4.');
});

test('reads a table row by row', () => {
  const markdown = '| City | Population |\n|---|---|\n| Jakarta | 11 million |';
  assert.equal(toSpeechText(markdown), 'City, Population. Jakarta, 11 million.');
});

test('truncates at the end of a sentence when it can', () => {
  const { text, truncated } = truncate('One two three. Four five six. Seven eight nine.', 35);
  assert.equal(truncated, true);
  assert.equal(text, 'One two three. Four five six.');
});

test('truncates at a word when no sentence ends late enough', () => {
  assert.deepEqual(truncate('alpha beta gamma delta', 13), { text: 'alpha beta…', truncated: true });
  assert.deepEqual(truncate('short', 10), { text: 'short', truncated: false });
});

test('a long reply is cut, points to the app, and stays within Alexa\'s SSML limit', () => {
  const reply = 'This & that are <important>. '.repeat(1_000);
  const out = replySsml(reply, 6_000);
  assert.ok(out.length <= 8_000, `length ${out.length}`);
  assert.match(out, /The full answer is in your Alexa app\.<\/speak>$/);
});

test('the card keeps links and code and fits Alexa\'s card limit', () => {
  const card = cardText('what is node', '**Node** runs JavaScript. See https://nodejs.org\n```\nnode app.js\n```');
  assert.equal(card, 'You: what is node\n\nNode runs JavaScript. See https://nodejs.org\n```\nnode app.js\n```');
  assert.ok(cardText('q', 'x'.repeat(20_000)).length <= 7_500);
});
