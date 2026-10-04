import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  getBrowserStatus,
  getOperatorCatalog,
  listBrowserAcquisitions,
  listJobs,
  listPendingApprovals,
  listStageGraphs,
  resolveConfig,
} from './api';
import type {
  ApprovalRequest,
  BrowserAcquisitionRecord,
  ChromeWorkerStatus,
  JobRecord,
  OperatorCatalog,
  StageGraphRecord,
} from './types';

export interface CockpitOverview {
  readonly jobs: readonly JobRecord[];
  readonly approvals: readonly ApprovalRequest[];
  readonly pipelines: readonly StageGraphRecord[];
  readonly captures: readonly BrowserAcquisitionRecord[];
  readonly worker: ChromeWorkerStatus | null;
  readonly catalog: OperatorCatalog | null;
  readonly loading: boolean;
  readonly error: ApiError | null;
  readonly updatedAt: Date | null;
}

function asApiError(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError(0, 'Unavailable', cause instanceof Error ? cause.message : String(cause));
}

const INITIAL: CockpitOverview = {
  jobs: [], approvals: [], pipelines: [], captures: [], worker: null, catalog: null,
  loading: true, error: null, updatedAt: null,
};

/** One non-overlapping, visibility-aware poller feeds the shell and attention surfaces. */
export function useCockpitOverview(intervalMs: number = 5_000): CockpitOverview & { readonly refresh: () => void } {
  const [overview, setOverview] = useState<CockpitOverview>(INITIAL);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load(): Promise<void> {
      if (!active) return;
      try {
        const config = await resolveConfig();
        const [jobs, pipelines, captures, worker, catalog, approvals] = await Promise.allSettled([
          listJobs(),
          listStageGraphs(),
          listBrowserAcquisitions(),
          getBrowserStatus(),
          getOperatorCatalog(),
          config.approvals_configured ? listPendingApprovals() : Promise.resolve([]),
        ]);
        if (!active) return;
        setOverview((current) => ({
          jobs: jobs.status === 'fulfilled' ? jobs.value : current.jobs,
          pipelines: pipelines.status === 'fulfilled' ? pipelines.value : current.pipelines,
          captures: captures.status === 'fulfilled' ? captures.value : current.captures,
          worker: worker.status === 'fulfilled' ? worker.value : current.worker,
          catalog: catalog.status === 'fulfilled' ? catalog.value : current.catalog,
          approvals: approvals.status === 'fulfilled' ? approvals.value : current.approvals,
          loading: false,
          error: jobs.status === 'rejected' ? asApiError(jobs.reason) : null,
          updatedAt: new Date(),
        }));
      } catch (cause: unknown) {
        if (active) setOverview((current) => ({ ...current, loading: false, error: asApiError(cause) }));
      } finally {
        if (active && document.visibilityState !== 'hidden') {
          timer = setTimeout(() => { void load(); }, intervalMs);
        }
      }
    }

    function visibilityChanged(): void {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      } else if (timer === null) {
        void load();
      }
    }

    if (document.visibilityState !== 'hidden') void load();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [intervalMs, tick]);

  return { ...overview, refresh };
}
