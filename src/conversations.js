// In-memory conversations, one per Alexa session. Kept in least-recently-used order so the
// oldest is always first: idle and surplus conversations are evicted from the front.

export class ConversationStore {
  constructor({ maxHistoryTurns, idleMs, maxSessions, now = Date.now }) {
    this.maxMessages = maxHistoryTurns * 2;
    this.idleMs = idleMs;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map();
  }

  /** Returns the conversation for a session, creating it if needed. */
  get(sessionId) {
    this.evictIdle();
    let conversation = this.sessions.get(sessionId);
    if (conversation) {
      this.sessions.delete(sessionId);
    } else {
      conversation = { history: [], pending: null };
    }
    conversation.lastSeen = this.now();
    this.sessions.set(sessionId, conversation);
    while (this.sessions.size > this.maxSessions) this.remove(this.sessions.keys().next().value);
    return conversation;
  }

  peek(sessionId) {
    return this.sessions.get(sessionId);
  }

  remove(sessionId) {
    const conversation = this.sessions.get(sessionId);
    if (!conversation) return;
    conversation.pending?.cancel();
    this.sessions.delete(sessionId);
  }

  /** Adds a question and the answer the user actually heard. */
  record(conversation, question, answer) {
    if (this.maxMessages === 0) return;
    conversation.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    if (conversation.history.length > this.maxMessages) {
      conversation.history.splice(0, conversation.history.length - this.maxMessages);
    }
  }

  evictIdle() {
    const cutoff = this.now() - this.idleMs;
    for (const [sessionId, conversation] of this.sessions) {
      if (conversation.lastSeen > cutoff) break;
      this.remove(sessionId);
    }
  }

  get size() {
    return this.sessions.size;
  }
}
