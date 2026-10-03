// In-memory conversations, one per speaker. A conversation outlives the Alexa session (the
// microphone closes after a few silent seconds) and ends after a period without questions,
// or when the speaker asks to start over.
//
// Kept in least-recently-used order, so the oldest is always first: idle and surplus
// conversations are evicted from the front.

import { randomUUID } from 'node:crypto';

export class ConversationStore {
  constructor({ maxHistoryTurns, idleMs, maxConversations, now = Date.now }) {
    this.maxMessages = maxHistoryTurns * 2;
    this.idleMs = idleMs;
    this.maxConversations = maxConversations;
    this.now = now;
    this.conversations = new Map();
  }

  /** Returns the speaker's current conversation, starting a new one if needed. */
  get(key) {
    this.evictIdle();
    let conversation = this.conversations.get(key);
    if (conversation) {
      this.conversations.delete(key);
    } else {
      conversation = { id: randomUUID(), history: [], pending: null };
    }
    conversation.lastSeen = this.now();
    this.conversations.set(key, conversation);
    while (this.conversations.size > this.maxConversations) this.remove(this.conversations.keys().next().value);
    return conversation;
  }

  peek(key) {
    this.evictIdle();
    return this.conversations.get(key);
  }

  remove(key) {
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    conversation.pending?.cancel();
    this.conversations.delete(key);
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
    for (const [key, conversation] of this.conversations) {
      if (conversation.lastSeen > cutoff) break;
      this.remove(key);
    }
  }

  get size() {
    return this.conversations.size;
  }
}
