// Turns a chat reply into something a speaker can read aloud, and into card text for the
// Alexa app. Alexa allows at most 8,000 characters of SSML per response and 8,000 characters
// per card (title and content together).

const SSML_LIMIT = 7_900;
const CARD_LIMIT = 7_500;

export function escapeSsml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function ssml(text) {
  return `<speak>${escapeSsml(text)}</speak>`;
}

/** Strips markdown, links, code and emoji so the text-to-speech voice reads only words. */
export function toSpeechText(markdown) {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?(```|$)/g, '\n(The code is in your Alexa app.)\n')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<?\bhttps?:\/\/[^\s>)]+?>?(?=[.,;:!?)"'”’]*(\s|$))/g, 'the link in your Alexa app')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\p{Extended_Pictographic}\uFE0F?|\u200D/gu, '')
    .split('\n');

  const spoken = [];
  for (let line of lines) {
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue; // table rule
    if (/^\s*([-*_]\s*){3,}$/.test(line)) continue; // horizontal rule
    line = line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
      .replace(/^\s*\|(.*)\|\s*$/, '$1')
      .replace(/\s*\|\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    spoken.push(/[.!?:;,…]["'”’)\]]*$/.test(line) ? line : `${line}.`);
  }
  return spoken.join(' ');
}

/** Cuts text to at most `max` characters, preferring the end of a sentence, then a word. */
export function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd >= max * 0.5) return { text: cut.slice(0, sentenceEnd + 1), truncated: true };
  const space = cut.lastIndexOf(' ');
  return { text: `${(space > 0 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}…`, truncated: true };
}

/**
 * Builds the SSML for a reply. When the reply is too long to speak in full, the spoken part
 * ends with a pointer to the Alexa app, where the card holds the whole answer.
 */
export function replySsml(reply, maxChars, { more = 'The full answer is in your Alexa app.' } = {}) {
  const words = toSpeechText(reply) || '…';
  let limit = maxChars;
  for (;;) {
    const { text, truncated } = truncate(words, limit);
    const out = ssml(truncated ? `${text} ${more}` : text);
    if (out.length <= SSML_LIMIT || limit <= 200) return out;
    limit = Math.floor(limit * 0.8); // escaping made it longer than Alexa accepts
  }
}

/** Card text for the Alexa app: keeps links and code, drops markdown decoration. */
export function cardText(question, reply) {
  const answer = reply
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .trim();
  return truncate(`You: ${question}\n\n${answer}`, CARD_LIMIT).text;
}
