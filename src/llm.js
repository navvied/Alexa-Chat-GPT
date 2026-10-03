// A minimal client for any OpenAI-compatible Chat Completions endpoint
// (api.openai.com, or a self-hosted server that speaks the same API).

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

export function createChatClient(options, fetchImpl = fetch) {
  const { baseUrl, apiKey, model, maxOutputTokens, temperature, reasoningEffort, timeoutMs } = options;
  const url = `${baseUrl}/chat/completions`;

  return {
    model,

    /**
     * @param {{ role: 'system' | 'user' | 'assistant', content: string }[]} messages
     * @param {{ signal?: AbortSignal }} [init]
     * @returns {Promise<string>} the reply text
     */
    async complete(messages, { signal } = {}) {
      const body = { model, messages };
      if (maxOutputTokens) body.max_completion_tokens = maxOutputTokens;
      if (temperature !== undefined) body.temperature = temperature;
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;

      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const timeout = AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
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
        const hint = res.status === 401 ? ' (check OPENAI_API_KEY)' : res.status === 404 ? ' (check OPENAI_MODEL)' : '';
        throw new ChatError(`HTTP ${res.status}${hint}: ${detail}`, { status: res.status });
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        if (timeout.aborted) throw new ChatError(`no reply within ${timeoutMs} ms`, { cause: err });
        throw new ChatError('reply was not valid JSON', { cause: err });
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
