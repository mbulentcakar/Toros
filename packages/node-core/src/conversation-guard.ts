import { ErrorCode } from '@toros/contracts';

import { toros } from './http.js';

/**
 * Serialises authority-changing conversation writes inside this Node Core.
 *
 * Approval is a check-and-consume operation: the proposal must still be the
 * final turn when its job is created. Sharing this guard with every turn writer
 * prevents a second approval, a new operator message, or a late Hermes write
 * from slipping between that check and the durable consumption turn.
 */
export interface ConversationGuard {
  readonly run: <T>(conversationId: string, work: () => Promise<T>) => Promise<T>;
}

export function createConversationGuard(): ConversationGuard {
  const active = new Set<string>();
  return {
    async run<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
      if (active.has(conversationId)) {
        throw toros(ErrorCode.E_PARALLEL_ACTION, 'A conversation update is already in progress');
      }
      active.add(conversationId);
      try {
        return await work();
      } finally {
        active.delete(conversationId);
      }
    },
  };
}
