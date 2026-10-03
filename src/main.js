// Entry point: node --env-file=.env src/main.js

import { loadConfig } from './config.js';
import { createChatClient } from './llm.js';
import { createHermesClient, UnsafeToolsError } from './hermes.js';
import { ConversationStore } from './conversations.js';
import { createAssistant } from './assistant.js';
import { createAlexaHandler, createProgressiveSender } from './alexa.js';
import { createRequestVerifier } from './verify.js';
import { createServer } from './server.js';
import { log } from './log.js';

// Exit status for a configuration error; the systemd unit does not restart on it.
const EXIT_CONFIG = 78;

let config;
try {
  config = loadConfig();
} catch (error) {
  log.error(error.message);
  process.exit(EXIT_CONFIG);
}

if (!config.verifyRequests) {
  log.warn('ALEXA_SKIP_VERIFICATION is on: requests are NOT checked to come from Alexa. Use this only for local testing.');
}

const chat = config.provider === 'hermes' ? createHermesClient(config.hermes) : createChatClient(config.openai);
const endpoint = config.provider === 'hermes' ? config.hermes.baseUrl : config.openai.baseUrl;

if (chat.checkTools) {
  try {
    await chat.checkTools();
    log.info('hermes tool check passed', { allowed: config.hermes.allowedTools });
  } catch (error) {
    // Unsafe tools, a wrong key or a wrong URL will not fix themselves: refuse to start.
    if (error instanceof UnsafeToolsError || error.status === 401 || error.status === 404) {
      log.error(error.message);
      process.exit(EXIT_CONFIG);
    }
    // Hermes may simply not be up yet; every question checks again until it passes.
    log.warn('hermes is not reachable yet; questions will fail until it is', { error: error.message });
  }
}

const store = new ConversationStore({
  maxHistoryTurns: config.maxHistoryTurns,
  idleMs: config.conversationIdleMs,
  maxConversations: config.maxConversations,
});
const assistant = createAssistant({ chat, store, config });
const handler = createAlexaHandler({ assistant, config, log, progressive: createProgressiveSender({ log }) });
const server = createServer({ config, handler, verifier: createRequestVerifier(), log });

server.listen(config.port, config.host, () => {
  log.info('listening', {
    url: `http://${config.host}:${config.port}${config.path}`,
    provider: chat.name,
    model: chat.model,
    endpoint,
  });
});

function shutdown(signal) {
  log.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
