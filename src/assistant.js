// The conversation logic, independent of Alexa's request format.
//
// Alexa waits about 8 seconds for a skill. A question that takes longer is not lost: it
// keeps running as the session's pending answer, and the user hears it when they say
// "continue". History only ever holds answers the user actually heard.

export function createAssistant({ chat, store, config, now = () => new Date() }) {
  const dateFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  });

  function systemMessage() {
    return {
      role: 'system',
      content: `${config.systemPrompt}\n\nCurrent date and time: ${dateFormat.format(now())} (${config.timezone}).`,
    };
  }

  function start(conversation, question) {
    const controller = new AbortController();
    const job = {
      question,
      settled: false,
      answer: null,
      error: null,
      cancel: () => controller.abort(),
    };
    const messages = [systemMessage(), ...conversation.history, { role: 'user', content: question }];
    job.done = chat
      .complete(messages, { signal: controller.signal })
      .then(
        (answer) => { job.answer = answer; },
        (error) => { job.error = error; },
      )
      .finally(() => { job.settled = true; });
    return job;
  }

  /** Waits for the job until the deadline; calls `onSlow` once if it is taking a while. */
  async function waitFor(job, onSlow) {
    if (job.settled) return true;
    const timers = [];
    const deadline = new Promise((resolve) => timers.push(setTimeout(resolve, config.answerDeadlineMs)));
    if (onSlow && config.progressiveAfterMs > 0 && config.progressiveAfterMs < config.answerDeadlineMs) {
      timers.push(setTimeout(onSlow, config.progressiveAfterMs));
    }
    await Promise.race([job.done, deadline]);
    timers.forEach(clearTimeout);
    return job.settled;
  }

  function deliver(conversation, job) {
    if (conversation.pending === job) conversation.pending = null;
    if (job.error) throw job.error;
    store.record(conversation, job.question, job.answer);
    return { status: 'answered', question: job.question, answer: job.answer };
  }

  return {
    /**
     * Asks a new question. A question still pending from before is dropped: the user
     * moved on without hearing it.
     * @returns {Promise<{status: 'answered', question: string, answer: string} | {status: 'pending'}>}
     */
    async ask(sessionId, question, { onSlow } = {}) {
      const conversation = store.get(sessionId);
      conversation.pending?.cancel();
      const job = start(conversation, question);
      conversation.pending = job;
      if (!(await waitFor(job, onSlow))) return { status: 'pending' };
      return deliver(conversation, job);
    },

    /**
     * Delivers the pending answer, if there is one.
     * @returns {Promise<{status: 'answered', question: string, answer: string} | {status: 'pending'} | {status: 'none'}>}
     */
    async resume(sessionId, { onSlow } = {}) {
      const conversation = store.get(sessionId);
      const job = conversation.pending;
      if (!job) return { status: 'none' };
      if (!(await waitFor(job, onSlow))) return { status: 'pending' };
      return deliver(conversation, job);
    },

    hasPending(sessionId) {
      return Boolean(store.peek(sessionId)?.pending);
    },

    end(sessionId) {
      store.remove(sessionId);
    },
  };
}
