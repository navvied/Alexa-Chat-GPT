// The conversation logic, independent of Alexa's request format.
//
// Alexa waits about 8 seconds for a skill. A question that takes longer is not lost: it
// keeps running as the conversation's pending answer, and the user hears it when they say
// "continue" (or open the skill again). Local history only ever holds answers the user
// actually heard; a client that keeps its own history (Hermes) gets none.

export function createAssistant({ chat, store, config, now = () => new Date() }) {
  const dateFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  });

  function systemPrompt() {
    return `${config.systemPrompt}\n\nCurrent date and time: ${dateFormat.format(now())} (${config.timezone}).`;
  }

  function start(speakerKey, conversation, question) {
    const controller = new AbortController();
    const job = {
      question,
      settled: false,
      answer: null,
      error: null,
      cancel: () => controller.abort(),
    };
    job.done = chat
      .reply({
        system: systemPrompt(),
        history: chat.keepsHistory ? [] : [...conversation.history],
        question,
        conversationId: `alexa-${conversation.id}`,
        speakerKey,
        signal: controller.signal,
      })
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
    if (!chat.keepsHistory) store.record(conversation, job.question, job.answer);
    return { status: 'answered', question: job.question, answer: job.answer };
  }

  return {
    /**
     * Asks a new question. A question still pending from before is dropped: the user
     * moved on without hearing it.
     * @returns {Promise<{status: 'answered', question: string, answer: string} | {status: 'pending'}>}
     */
    async ask(speakerKey, question, { onSlow } = {}) {
      const conversation = store.get(speakerKey);
      conversation.pending?.cancel();
      const job = start(speakerKey, conversation, question);
      conversation.pending = job;
      if (!(await waitFor(job, onSlow))) return { status: 'pending' };
      return deliver(conversation, job);
    },

    /**
     * Delivers the pending answer, if there is one.
     * @returns {Promise<{status: 'answered', question: string, answer: string} | {status: 'pending'} | {status: 'none'}>}
     */
    async resume(speakerKey, { onSlow } = {}) {
      const conversation = store.peek(speakerKey);
      const job = conversation?.pending;
      if (!job) return { status: 'none' };
      store.get(speakerKey); // counts as activity
      if (!(await waitFor(job, onSlow))) return { status: 'pending' };
      return deliver(conversation, job);
    },

    hasPending(speakerKey) {
      return Boolean(store.peek(speakerKey)?.pending);
    },

    /** Stops waiting for an unheard answer but keeps the conversation. */
    cancelPending(speakerKey) {
      const conversation = store.peek(speakerKey);
      if (!conversation?.pending) return;
      conversation.pending.cancel();
      conversation.pending = null;
    },

    /** Forgets the conversation; the next question starts a new one. */
    startOver(speakerKey) {
      store.remove(speakerKey);
    },
  };
}
