export type BrowserAcquisitionState = 'running' | 'waiting' | 'paused' | 'completed' | 'stopped';
export type BrowserItemState = 'pending' | 'running' | 'completed' | 'paused';
export type BrowserDocumentState = 'pending' | 'completed' | 'failed' | 'not_found';
export type BrowserSiteProfile = 'generic';

export interface BrowserFieldRule {
  readonly name: string;
  readonly selector: string;
  readonly attribute?: string;
}

export interface BrowserDocumentRule {
  readonly kind: string;
  readonly text_contains: readonly string[];
  readonly url_contains: readonly string[];
  readonly required: boolean;
  readonly max_files: number;
}

export interface BrowserAcquisitionSource {
  readonly item_id: string;
  readonly url: string;
}

export interface BrowserAcquisitionInput {
  readonly name: string;
  readonly workspace_id: string;
  readonly site_profile: BrowserSiteProfile;
  readonly sources: readonly BrowserAcquisitionSource[];
  readonly fields: readonly BrowserFieldRule[];
  readonly documents: readonly BrowserDocumentRule[];
  readonly min_delay_seconds: number;
  readonly max_delay_seconds: number;
  readonly max_attempts: number;
  readonly max_backoff_minutes: number;
  readonly max_consecutive_rate_limits: number;
  readonly max_document_bytes: number;
}

export interface BrowserAcquisitionDocument {
  readonly kind: string;
  readonly url: string | null;
  readonly text: string;
  readonly state: BrowserDocumentState;
  readonly outcome: string;
  readonly http_status: number | null;
  readonly content_type: string | null;
  readonly path: string | null;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly duplicate_of: string | null;
  readonly error: string | null;
}

export interface BrowserAcquisitionItem {
  readonly item_id: string;
  readonly manifest_index: number;
  readonly url: string;
  readonly final_url: string | null;
  readonly page_outcome: string;
  readonly page_http_status: number | null;
  readonly product_title: string | null;
  readonly retry_after_seconds: number | null;
  readonly error_code: string | null;
  readonly state: BrowserItemState;
  readonly attempts: number;
  readonly fields: Readonly<Record<string, string | null>>;
  readonly documents: readonly BrowserAcquisitionDocument[];
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly error: string | null;
}

export interface BrowserAcquisitionRecord {
  readonly acquisition_id: string;
  readonly name: string;
  readonly workspace_id: string;
  readonly site_profile: BrowserSiteProfile;
  readonly job_id: string;
  readonly state: BrowserAcquisitionState;
  readonly current_item: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly error: string | null;
  readonly manifest_path: string;
  readonly fields: readonly BrowserFieldRule[];
  readonly document_rules: readonly BrowserDocumentRule[];
  readonly min_delay_seconds: number;
  readonly max_delay_seconds: number;
  readonly max_attempts: number;
  readonly max_backoff_minutes: number;
  readonly max_consecutive_rate_limits: number;
  readonly consecutive_rate_limits: number;
  readonly max_document_bytes: number;
  readonly items: readonly BrowserAcquisitionItem[];
}
