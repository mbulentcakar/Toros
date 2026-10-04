import { useEffect, useState, useCallback } from 'react';
import { ApiError } from './api';

/**
 * PollState — the three states every data-fetching view cares about.
 */
export interface PollState<T> {
  /** The most recent successful fetch result, or null if none. */
  readonly data: T | null;
  /** True only during the very first fetch. Subsequent refreshes preserve data. */
  readonly loading: boolean;
  /** Non-null when the last fetch failed. */
  readonly error: ApiError | null;
  /** Force a refresh now. */
  readonly refresh: () => void;
}

/**
 * Poll a data fetcher on an interval.
 *
 * Uses one recursive timeout so slow requests cannot overlap. Polling pauses
 * while the window is hidden; Node Core remains the durable source of truth.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number = 3000,
  enabled: boolean = true,
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      if (!active) return;
      try {
        const result = await fetcher();
        if (active) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (active) {
          setError(
            e instanceof ApiError
              ? e
              : new ApiError(
                  0,
                  'Network error',
                  e instanceof Error ? e.message : String(e),
                ),
          );
        }
      } finally {
        if (active) {
          setLoading(false);
          if (document.visibilityState !== 'hidden') {
            timer = setTimeout(() => { void load(); }, intervalMs);
          }
        }
      }
    };

    const visibilityChanged = (): void => {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return;
      }
      if (timer === null) void load();
    };

    if (document.visibilityState !== 'hidden') void load();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [enabled, fetcher, intervalMs, tick]);

  return { data, loading, error, refresh };
}
