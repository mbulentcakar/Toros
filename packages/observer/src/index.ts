/**
 * @toros/observer — Numbat monitor-only observer
 *
 * Tails NDJSON records from Numbat, correlates them to Toros sessions and
 * receipts by the four routes SPEC §8.2 defines, redacts sensitive fields,
 * and hands findings to the store.
 *
 * **This unit observes. It never decides.**
 */

export {
  createNumbatObserver,
  createNullObserver,
  type NumbatObserverOptions,
} from './observer.js';