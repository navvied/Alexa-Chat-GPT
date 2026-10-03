// Entry point: node --env-file=.env src/main.js

import { loadConfig } from './config.js';
import { createChatClient } from './llm.js';
import { ConversationStore } from './conversations.js';
import { createAssistant } from './assistant.js';
import { createAlexaHandler, createProgressiveSender } from './alexa.js';
import { createRequestVerifier } from './verify.js';
import { createServer } from './server.js';
import { log } from './log.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  log.error(error.message);
  process.exit(1);
}

if (!config.verifyRequests) {
  log.warn('ALEXA_SKIP_VERIFICATION is on: requests are NOT checked to come from Alexa. Use this only for local testing.');
}

const store = new ConversationStore({
  maxHistoryTurns: config.maxHistoryTurns,
  idleMs: config.sessionIdleMs,
  maxSessions: config.maxSessions,
});
const assistant = createAssistant({ chat: createChatClient(config.openai), store, config });
const handler = createAlexaHandler({ assistant, config, log, progressive: createProgressiveSender({ log }) });
const server = createServer({ config, handler, verifier: createRequestVerifier(), log });

server.listen(config.port, config.host, () => {
  log.info('listening', {
    url: `http://${config.host}:${config.port}${config.path}`,
    model: config.openai.model,
    endpoint: config.openai.baseUrl,
  });
});

function shutdown(signal) {
  log.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
