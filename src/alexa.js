// Maps Alexa requests onto the assistant and builds Alexa responses.
// Request and response format:
// https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html

import { cardText, replySsml, ssml } from './speech.js';

const CARD_TITLE = 'ChatGPT';

export const SPEECH = {
  launch: 'Hi! What would you like to ask?',
  launchReprompt: 'You can ask me anything.',
  help: 'You can ask me anything, like "explain how vaccines work" or "give me a dinner idea". '
    + 'I remember what we talked about until you say stop. What would you like to ask?',
  helpReprompt: 'What would you like to ask?',
  followUp: 'Anything else?',
  thinking: 'Let me think.',
  pending: 'That one needs a little more thought. Say "continue" to hear the answer.',
  pendingReprompt: 'Say "continue" to hear the answer.',
  stillPending: 'Still working on it. Say "continue" again in a few seconds.',
  nothingPending: 'What would you like to ask?',
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

function respond({ speech, reprompt, card, end = false }) {
  const response = { outputSpeech: { type: 'SSML', ssml: speech }, shouldEndSession: end };
  if (reprompt) response.reprompt = { outputSpeech: { type: 'SSML', ssml: ssml(reprompt) } };
  if (card) response.card = { type: 'Simple', title: CARD_TITLE, content: card };
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
  function toResponse(result, sessionId) {
    if (result.status === 'answered') {
      return respond({
        speech: replySsml(result.answer, config.maxSpeechChars),
        reprompt: SPEECH.followUp,
        card: cardText(result.question, result.answer),
      });
    }
    if (result.status === 'pending') {
      log.info('answer pending', { session: sessionId.slice(-8) });
      return say(SPEECH.pending, SPEECH.pendingReprompt);
    }
    return say(SPEECH.nothingPending, SPEECH.launchReprompt);
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

  async function chat(envelope, sessionId, question) {
    if (config.logConversations) log.info('question', { text: question });
    const result = await run(envelope, (onSlow) => assistant.ask(sessionId, question, { onSlow }));
    if (result.status === 'failed') return say(SPEECH.failed, SPEECH.helpReprompt);
    if (config.logConversations && result.status === 'answered') log.info('answer', { text: result.answer });
    return toResponse(result, sessionId);
  }

  async function resume(envelope, sessionId) {
    const result = await run(envelope, (onSlow) => assistant.resume(sessionId, { onSlow }));
    if (result.status === 'failed') return say(SPEECH.failed, SPEECH.helpReprompt);
    if (result.status === 'pending') return say(SPEECH.stillPending, SPEECH.pendingReprompt);
    if (config.logConversations && result.status === 'answered') log.info('answer', { text: result.answer });
    return toResponse(result, sessionId);
  }

  return {
    async handle(envelope) {
      const request = envelope.request ?? {};
      const sessionId = envelope.session?.sessionId ?? request.requestId ?? 'no-session';

      switch (request.type) {
        case 'LaunchRequest':
          return say(SPEECH.launch, SPEECH.launchReprompt);

        case 'SessionEndedRequest':
          if (request.error) log.warn('session ended with an error', { reason: request.reason, error: request.error });
          assistant.end(sessionId);
          return EMPTY;

        case 'IntentRequest':
          break;

        default:
          if (request.type === 'System.ExceptionEncountered') log.warn('alexa reported an exception', { error: request.error });
          return EMPTY;
      }

      const intent = request.intent?.name;
      switch (intent) {
        case 'ChatIntent': {
          const question = request.intent.slots?.query?.value?.trim();
          if (!question) return say(SPEECH.notHeard, SPEECH.helpReprompt);
          if (CONTINUE_PHRASES.has(normalize(question)) && assistant.hasPending(sessionId)) {
            return resume(envelope, sessionId);
          }
          return chat(envelope, sessionId, question);
        }

        case 'ContinueIntent':
        case 'AMAZON.YesIntent':
        case 'AMAZON.ResumeIntent':
          return resume(envelope, sessionId);

        case 'AMAZON.HelpIntent':
          return say(SPEECH.help, SPEECH.helpReprompt);

        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent':
        case 'AMAZON.NoIntent':
        case 'AMAZON.PauseIntent':
          assistant.end(sessionId);
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
