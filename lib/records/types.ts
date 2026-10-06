export type RecordKind = "task" | "note" | "idea" | "event" | "reference";
export type CaptureSource = "text" | "voice" | "telegram" | "legacy";
export type RecordStatus = "active" | "archived";
export type OrganizationProvider = "local" | "gemini";

export interface RecordInterpretation {
  provider: OrganizationProvider;
  confidence: number;
  warnings: string[];
  inferred_fields: string[];
}

export interface CapturedRecord {
  id: string;
  user_id: string;
  title: string;
  content: string;
  kind: RecordKind;
  collection: string;
  tags: string[];
  contacts: string[];
  deadline: string | null;
  created_at: string;
  updated_at: string;
  source: CaptureSource;
  status: RecordStatus;
  capture_id: string;
  interpretation: RecordInterpretation;
}

export type OrganizedRecord = Omit<
  CapturedRecord,
  "id" | "user_id" | "created_at" | "updated_at" | "capture_id" | "status"
>;

export interface OrganizeContext {
  now?: Date;
  timezone: string;
  projects?: string[];
  contacts?: string[];
}

export interface OrganizedCapture {
  entries: OrganizedRecord[];
  provider: OrganizationProvider;
  /** Only names stated explicitly or matched against the user's existing data. */
  associations: { collections: string[]; contacts: string[] };
}

export interface DeadlineProgress {
  remaining_percent: number | null;
  remaining_ms: number | null;
  overdue: boolean;
  has_deadline: boolean;
}
