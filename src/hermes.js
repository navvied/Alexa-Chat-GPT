// Client for a Hermes Agent API server (https://hermes-agent.nousresearch.com), using its
// OpenAI-compatible Responses endpoint with a named conversation: Hermes keeps the history
// (tool calls included) and its own long-term memory, so only the new question is sent.
//
// Voice is an open door: anyone near the speaker, or a TV, can ask for anything. Before it
// answers, this client checks which tools Hermes exposes on its API server and refuses to
// work while any of them falls outside the allowed list.

import { ChatError, postJson } from './llm.js';

const TOOL_CHECK_TTL_MS = 5 * 60 * 1000;
const TOOL_CHECK_TIMEOUT_MS = 10_000;

/** Hermes reports some upstream failures (no provider, expired login, used-up quota) as answer text
 * that starts with a warning sign. */
const FAILURE_TEXT = /^\s*\u26A0/u;

export class UnsafeToolsError extends ChatError {
  constructor(tools) {
    super(
      `Hermes exposes tools that must not be reachable by voice: ${tools.join(', ')}. `
      + 'Disable their toolsets in the Hermes profile (agent.disabled_toolsets in config.yaml), '
      + 'or allow specific tools on purpose with HERMES_EXTRA_TOOLS.',
    );
    this.name = 'UnsafeToolsError';
    this.tools = tools;
  }
}

function toolsetList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.toolsets)) return data.toolsets;
  throw new ChatError('Hermes /v1/toolsets returned an unexpected shape');
}

/** Returns "tool (toolset)" for every enabled tool that is not allowed. */
export function findUnsafeTools(toolsets, allowedTools) {
  const allowed = new Set(allowedTools);
  const unsafe = [];
  for (const toolset of toolsets) {
    if (toolset?.enabled === false) continue;
    const tools = Array.isArray(toolset?.tools) ? toolset.tools : [];
    // A toolset that does not list its tools cannot be checked, so it counts as unsafe.
    if (tools.length === 0 && !allowed.has(toolset?.name)) unsafe.push(`${toolset?.name ?? 'unnamed'} (toolset)`);
    for (const tool of tools) {
      if (!allowed.has(tool)) unsafe.push(`${tool} (${toolset.name})`);
    }
  }
  return unsafe;
}

/** The final answer: the last assistant message that is not mid-turn commentary. */
export function responseText(data) {
  const messages = (Array.isArray(data?.output) ? data.output : [])
    .filter((item) => item?.type === 'message' && item.phase !== 'commentary');
  const last = messages.at(-1);
  if (last) {
    const content = Array.isArray(last.content) ? last.content : [];
    return content
      .filter((part) => part?.type === 'output_text' || part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
      .trim();
  }
  return typeof data?.output_text === 'string' ? data.output_text.trim() : '';
}

export function createHermesClient(options, fetchImpl = fetch, now = Date.now) {
  const { baseUrl, apiKey, model, timeoutMs, allowedTools } = options;
  const auth = { authorization: `Bearer ${apiKey}` };
  let checkedAt = -Infinity;

  async function checkTools() {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/toolsets`, { headers: auth, signal: AbortSignal.timeout(TOOL_CHECK_TIMEOUT_MS) });
    } catch (err) {
      throw new ChatError(`could not reach Hermes at ${baseUrl}: ${err.message}`, { cause: err });
    }
    if (!res.ok) {
      const hint = res.status === 401 ? ' (check HERMES_API_KEY)' : res.status === 404 ? ' (check HERMES_BASE_URL; it must end in /v1)' : '';
      throw new ChatError(`Hermes tool check failed with HTTP ${res.status}${hint}`, { status: res.status });
    }
    const unsafe = findUnsafeTools(toolsetList(await res.json()), allowedTools);
    if (unsafe.length > 0) throw new UnsafeToolsError(unsafe);
    checkedAt = now();
  }

  return {
    name: 'hermes',
    model,
    keepsHistory: true,
    checkTools,

    async reply({ system, question, conversationId, speakerKey, signal }) {
      if (now() - checkedAt > TOOL_CHECK_TTL_MS) await checkTools();

      const headers = { ...auth };
      // Scopes long-term memory to one speaker (see "X-Hermes-Session-Key" in the Hermes docs).
      if (speakerKey) headers['x-hermes-session-key'] = speakerKey;

      const data = await postJson(`${baseUrl}/responses`, {
        headers,
        body: { model, input: question, instructions: system, conversation: conversationId, stream: false },
        timeoutMs,
        signal,
        fetchImpl,
        keyHint: 'HERMES_API_KEY',
      });

      if (data?.status === 'failed' || data?.error) {
        const detail = data?.error?.message ?? JSON.stringify(data?.error ?? data?.status);
        throw new ChatError(`Hermes run failed: ${String(detail).slice(0, 300)}`);
      }
      const text = responseText(data);
      if (!text) throw new ChatError(`Hermes reply was empty (status: ${data?.status ?? 'unknown'})`);
      if (FAILURE_TEXT.test(text)) throw new ChatError(`Hermes reported a problem: ${text.slice(0, 300)}`);
      return text;
    },
  };
}
