// Reads every setting from environment variables (see .env.example) and fails fast,
// listing every problem at once, when something required is missing or malformed.

const VOICE_RULES = `You are talking to the user through an Amazon Alexa speaker.
Everything you write is read aloud by a text-to-speech voice, so:
- Answer in plain spoken sentences. No markdown, lists, headings, tables, emoji, links or code.
- Keep it short: two to four sentences, unless the user asks for more detail.
- Reply in the language the user speaks to you.`;

export const DEFAULT_SYSTEM_PROMPTS = {
  openai: `${VOICE_RULES}
- If a question needs live information you do not have, such as news, weather or prices, say so briefly.`,
  hermes: `${VOICE_RULES}
- The user is standing at a speaker, waiting. Use a tool only when the question needs it, and answer as soon as you can.`,
};

// Tools a voice request may reach on Hermes. Anyone who can talk to the speaker can ask
// for anything, so nothing here can run commands, touch files or act on other systems.
export const SAFE_HERMES_TOOLS = ['web_search', 'web_extract', 'memory', 'session_search', 'todo_list'];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function loadConfig(env = process.env) {
  const errors = [];

  const text = (name, fallback) => {
    const value = env[name]?.trim();
    return value ? value : fallback;
  };
  const integer = (name, fallback, min, max) => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  };
  const number = (name, min, max) => {
    const raw = text(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${name} must be a number from ${min} to ${max} (got "${raw}")`);
      return undefined;
    }
    return value;
  };
  const flag = (name, fallback) => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    errors.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  };
  const baseUrl = (name, fallback) => {
    const raw = text(name, fallback);
    if (!raw) {
      errors.push(`${name} is required`);
      return { url: '', host: '' };
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
      return { url: raw.replace(/\/+$/, ''), host: parsed.hostname, secure: parsed.protocol === 'https:' };
    } catch {
      errors.push(`${name} is not a valid http(s) URL (got "${raw}")`);
      return { url: '', host: '' };
    }
  };

  const skillId = text('ALEXA_SKILL_ID');
  if (!skillId) errors.push('ALEXA_SKILL_ID is required (Alexa Developer Console > your skill > Endpoint)');
  else if (!skillId.startsWith('amzn1.ask.skill.')) errors.push('ALEXA_SKILL_ID must start with amzn1.ask.skill.');

  const path = text('ALEXA_PATH', '/alexa');
  if (!path.startsWith('/')) errors.push('ALEXA_PATH must start with /');

  const provider = text('CHAT_PROVIDER', 'openai');
  if (provider !== 'openai' && provider !== 'hermes') {
    errors.push(`CHAT_PROVIDER must be openai or hermes (got "${provider}")`);
  }

  let openai;
  if (provider === 'openai') {
    const base = baseUrl('OPENAI_BASE_URL', 'https://api.openai.com/v1');
    const apiKey = text('OPENAI_API_KEY', '');
    if (!apiKey && base.host === 'api.openai.com') errors.push('OPENAI_API_KEY is required for api.openai.com');
    openai = {
      baseUrl: base.url,
      apiKey,
      model: text('OPENAI_MODEL', 'chat-latest'),
      maxOutputTokens: integer('OPENAI_MAX_OUTPUT_TOKENS', 600, 0, 32000) || undefined,
      temperature: number('OPENAI_TEMPERATURE', 0, 2),
      reasoningEffort: text('OPENAI_REASONING_EFFORT'),
      timeoutMs: integer('OPENAI_TIMEOUT_MS', 60_000, 1_000, 300_000),
    };
  }

  let hermes;
  if (provider === 'hermes') {
    const base = baseUrl('HERMES_BASE_URL');
    // The API key opens an agent; it never travels over plain HTTP outside this machine.
    if (base.url && !base.secure && !LOOPBACK_HOSTS.has(base.host)) {
      errors.push('HERMES_BASE_URL must use https unless Hermes runs on this machine (127.0.0.1)');
    }
    const apiKey = text('HERMES_API_KEY', '');
    if (!apiKey) errors.push('HERMES_API_KEY is required (API_SERVER_KEY in the Hermes profile .env)');
    hermes = {
      baseUrl: base.url,
      apiKey,
      model: text('HERMES_MODEL', 'hermes-agent'),
      timeoutMs: integer('HERMES_TIMEOUT_MS', 120_000, 1_000, 600_000),
      allowedTools: [
        ...SAFE_HERMES_TOOLS,
        ...text('HERMES_EXTRA_TOOLS', '').split(',').map((tool) => tool.trim()).filter(Boolean),
      ],
    };
  }

  const timezone = text('TIMEZONE', 'Asia/Jakarta');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    errors.push(`TIMEZONE is not a valid IANA time zone (got "${timezone}")`);
  }

  const config = {
    host: text('HOST', '127.0.0.1'),
    port: integer('PORT', 8787, 1, 65535),
    path,
    skillId,
    verifyRequests: !flag('ALEXA_SKIP_VERIFICATION', false),
    provider,
    openai,
    hermes,
    systemPrompt: (text('SYSTEM_PROMPT') ?? DEFAULT_SYSTEM_PROMPTS[provider] ?? '').replace(/\\n/g, '\n'),
    timezone,
    // Alexa gives a skill 8 seconds in total; this leaves room for the network.
    answerDeadlineMs: integer('ANSWER_DEADLINE_MS', 6_000, 1_000, 7_500),
    progressiveAfterMs: integer('PROGRESSIVE_AFTER_MS', 1_500, 0, 7_500),
    maxHistoryTurns: integer('MAX_HISTORY_TURNS', 10, 0, 100),
    // Alexa closes the microphone after a few silent seconds; the conversation outlives that.
    conversationIdleMs: integer('CONVERSATION_IDLE_MINUTES', 15, 1, 24 * 60) * 60_000,
    maxConversations: integer('MAX_CONVERSATIONS', 500, 1, 100_000),
    maxSpeechChars: integer('MAX_SPEECH_CHARS', 6_000, 200, 7_000),
    logConversations: flag('LOG_CONVERSATIONS', false),
  };

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
