// Maps Alexa requests onto the assistant and builds Alexa responses.
// Request and response format:
// https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html

import { createHash } from 'node:crypto';
import { cardText, replySsml, ssml } from './speech.js';

export const SPEECH = {
  launch: 'Hi! What would you like to ask?',
  launchReprompt: 'You can ask me anything.',
  help: 'You can ask me anything, like "explain how vaccines work" or "give me a dinner idea". '
    + 'I keep our conversation going for a while, so you can ask follow-up questions. '
    + 'Say "start over" for a new topic, or "stop" to finish. What would you like to ask?',
  helpReprompt: 'What would you like to ask?',
  followUp: 'Anything else?',
  thinking: 'Let me think.',
  pending: 'That one needs a little more thought. Say "continue" to hear the answer.',
  pendingReprompt: 'Say "continue" to hear the answer.',
  stillPending: 'Still working on it. Say "continue" again in a few seconds.',
  nothingPending: 'What would you like to ask?',
  startOver: "Okay, let's start fresh. What would you like to ask?",
  notHeard: "Sorry, I didn't catch that. Could you say it again?",
  failed: "Sorry, I couldn't get an answer just now. Please try again.",
  goodbye: 'Goodbye!',
};

// Said as the whole query, these mean "continue" even if Alexa routed them to ChatIntent.
const CONTINUE_PHRASES = new Set([
  'continue', 'go on', 'go ahead', 'keep going', 'ready', 'i am ready', "i'm ready",
  'yes', 'yeah', 'ok', 'okay', 'what is the answer', "what's the answer", 'tell me the answer',
]);

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Who is speaking: the recognized voice profile when there is one, otherwise the Amazon
 * account. Hashed, so the raw Amazon ids never leave this service.
 */
export function speakerKey(envelope) {
  const system = envelope.context?.System ?? {};
  const id = system.person?.personId
    ?? system.user?.userId
    ?? envelope.session?.user?.userId
    ?? envelope.session?.sessionId
    ?? envelope.request?.requestId
    ?? 'unknown';
  return `alexa:${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

function respond({ speech, reprompt, card, end = false }) {
  const response = { outputSpeech: { type: 'SSML', ssml: speech }, shouldEndSession: end };
  if (reprompt) response.reprompt = { outputSpeech: { type: 'SSML', ssml: ssml(reprompt) } };
  if (card) response.card = { type: 'Simple', title: 'ChatGPT', content: card };
  return { version: '1.0', response };
}

const say = (text, reprompt) => respond({ speech: ssml(text), reprompt });

const EMPTY = { version: '1.0', response: {} };

/**
 * @param {object} deps
 * @param {ReturnType<import('./assistant.js').createAssistant>} deps.assistant
 * @param {(envelope: object, text: string) => void} [deps.progressive] speaks while we wait
 */
export function createAlexaHandler({ assistant, config, log, progressive = () => {} }) {
  function answered(result) {
    if (config.logConversations) log.info('answer', { text: result.answer });
    return respond({
      speech: replySsml(result.answer, config.maxSpeechChars),
      reprompt: SPEECH.followUp,
      card: cardText(result.question, result.answer),
    });
  }

  async function run(envelope, action) {
    const started = Date.now();
    const onSlow = () => progressive(envelope, SPEECH.thinking);
    try {
      const result = await action(onSlow);
      log.info('turn', { status: result.status, ms: Date.now() - started });
      return result;
    } catch (error) {
      log.error('chat failed', { error: error.message, status: error.status, ms: Date.now() - started });
      return { status: 'failed' };
    }
  }

  async function chat(envelope, speaker, question) {
    if (config.logConversations) log.info('question', { text: question });
    const result = await run(envelope, (onSlow) => assistant.ask(speaker, question, { onSlow }));
    if (result.status === 'answered') return answered(result);
    if (result.status === 'pending') return say(SPEECH.pending, SPEECH.pendingReprompt);
    return say(SPEECH.failed, SPEECH.helpReprompt);
  }

  /** Delivers the pending answer; `none` decides what to say when there is nothing pending. */
  async function resume(envelope, speaker, none) {
    const result = await run(envelope, (onSlow) => assistant.resume(speaker, { onSlow }));
    if (result.status === 'answered') return answered(result);
    if (result.status === 'pending') return say(SPEECH.stillPending, SPEECH.pendingReprompt);
    if (result.status === 'none') return none();
    return say(SPEECH.failed, SPEECH.helpReprompt);
  }

  return {
    async handle(envelope) {
      const request = envelope.request ?? {};
      const speaker = speakerKey(envelope);

      switch (request.type) {
        case 'LaunchRequest':
          // Opening the skill again also collects an answer that was still on its way.
          if (assistant.hasPending(speaker)) {
            return resume(envelope, speaker, () => say(SPEECH.launch, SPEECH.launchReprompt));
          }
          return say(SPEECH.launch, SPEECH.launchReprompt);

        case 'SessionEndedRequest':
          if (request.error) log.warn('session ended with an error', { reason: request.reason, error: request.error });
          return EMPTY;

        case 'IntentRequest':
          break;

        default:
          if (request.type === 'System.ExceptionEncountered') log.warn('alexa reported an exception', { error: request.error });
          return EMPTY;
      }

      switch (request.intent?.name) {
        case 'ChatIntent': {
          const question = request.intent.slots?.query?.value?.trim();
          if (!question) return say(SPEECH.notHeard, SPEECH.helpReprompt);
          if (CONTINUE_PHRASES.has(normalize(question)) && assistant.hasPending(speaker)) {
            return resume(envelope, speaker, () => say(SPEECH.nothingPending, SPEECH.launchReprompt));
          }
          return chat(envelope, speaker, question);
        }

        case 'ContinueIntent':
        case 'AMAZON.YesIntent':
        case 'AMAZON.ResumeIntent':
          return resume(envelope, speaker, () => say(SPEECH.nothingPending, SPEECH.launchReprompt));

        case 'AMAZON.StartOverIntent':
          assistant.startOver(speaker);
          return say(SPEECH.startOver, SPEECH.helpReprompt);

        case 'AMAZON.HelpIntent':
          return say(SPEECH.help, SPEECH.helpReprompt);

        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent':
        case 'AMAZON.NoIntent':
        case 'AMAZON.PauseIntent':
          // The conversation stays, so a follow-up a few minutes later still has context.
          assistant.cancelPending(speaker);
          return respond({ speech: ssml(SPEECH.goodbye), end: true });

        case 'AMAZON.NavigateHomeIntent':
          return say(SPEECH.launch, SPEECH.launchReprompt);

        case 'AMAZON.FallbackIntent':
        default:
          return say(SPEECH.notHeard, SPEECH.helpReprompt);
      }
    },
  };
}

/**
 * Sends a progressive response ("Let me think.") while the answer is being prepared.
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/send-the-user-a-progressive-response.html
 */
export function createProgressiveSender({ log, fetchImpl = fetch }) {
  return (envelope, text) => {
    const { apiEndpoint, apiAccessToken } = envelope.context?.System ?? {};
    const requestId = envelope.request?.requestId;
    if (!apiEndpoint || !apiAccessToken || !requestId) return;
    let endpoint;
    try {
      endpoint = new URL(apiEndpoint);
    } catch {
      return;
    }
    // The token is only ever sent to Amazon.
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.amazonalexa.com')) return;

    fetchImpl(new URL('/v1/directives', endpoint), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        header: { requestId },
        directive: { type: 'VoicePlayer.Speak', speech: ssml(text) },
      }),
      signal: AbortSignal.timeout(3_000),
    })
      .then((res) => {
        if (!res.ok) log.warn('progressive response rejected', { status: res.status });
      })
      .catch((error) => log.warn('progressive response failed', { error: error.message }));
  };
}
