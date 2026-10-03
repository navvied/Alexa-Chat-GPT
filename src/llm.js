// A minimal client for any OpenAI-compatible Chat Completions endpoint
// (api.openai.com, or a self-hosted server that speaks the same API).
//
// Every chat client offers the same method:
//   reply({ system, history, question, conversationId, speakerKey, signal }) → Promise<string>
// This one is stateless: it sends the system prompt and the history with every question.

export class ChatError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'ChatError';
    this.status = status;
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

/**
 * POSTs JSON with a timeout and an optional caller signal, and returns the parsed reply.
 * Shared by the OpenAI and Hermes clients.
 */
export async function postJson(url, { headers, body, timeoutMs, signal, fetchImpl, keyHint }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (timeout.aborted) throw new ChatError(`no reply within ${timeoutMs} ms`, { cause: err });
    if (signal?.aborted) throw new ChatError('request was cancelled', { cause: err });
    throw new ChatError(`could not reach ${url}: ${err.message}`, { cause: err });
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const hint = res.status === 401 ? ` (check ${keyHint})` : '';
    throw new ChatError(`HTTP ${res.status}${hint}: ${detail}`, { status: res.status });
  }

  try {
    return await res.json();
  } catch (err) {
    if (timeout.aborted) throw new ChatError(`no reply within ${timeoutMs} ms`, { cause: err });
    throw new ChatError('reply was not valid JSON', { cause: err });
  }
}

export function createChatClient(options, fetchImpl = fetch) {
  const { baseUrl, apiKey, model, maxOutputTokens, temperature, reasoningEffort, timeoutMs } = options;
  const url = `${baseUrl}/chat/completions`;

  return {
    name: 'openai',
    model,

    async reply({ system, history = [], question, signal }) {
      const body = {
        model,
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: question }],
      };
      if (maxOutputTokens) body.max_completion_tokens = maxOutputTokens;
      if (temperature !== undefined) body.temperature = temperature;
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;

      const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
      let data;
      try {
        data = await postJson(url, { headers, body, timeoutMs, signal, fetchImpl, keyHint: 'OPENAI_API_KEY' });
      } catch (err) {
        if (err.status === 404) err.message += ' (check OPENAI_MODEL and OPENAI_BASE_URL)';
        throw err;
      }

      const choice = data?.choices?.[0];
      const reply = contentText(choice?.message?.content).trim();
      if (!reply) {
        const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : '';
        throw new ChatError(`reply was empty${reason}`);
      }
      return reply;
    },
  };
}
