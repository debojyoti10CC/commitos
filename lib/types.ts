import type { CapturedRecord } from "./records/types";

export const STATUSES = [
  "inbox",
  "scheduled",
  "in_progress",
  "waiting",
  "blocked",
  "done",
  "cancelled",
] as const;
export const TYPES = [
  "deliverable",
  "communication",
  "follow_up",
  "deadline",
  "academic",
  "administrative",
  "meeting",
  "content",
  "project",
  "recurring",
  "personal",
  "other",
] as const;
export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export const RISKS = [
  "safe",
  "attention",
  "high",
  "critical",
  "impossible",
] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type RiskLevel = (typeof RISKS)[number];
export interface Commitment {
  id: string;
  user_id: string;
  title: string;
  description: string;
  project: string | null;
  commitment_type: (typeof TYPES)[number];
  contact_name: string | null;
  organization: string | null;
  source: string;
  source_reference: string | null;
  source_url: string | null;
  status: Status;
  priority: Priority;
  created_at: string;
  updated_at: string;
  deadline: string | null;
  check_in_at: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  estimated_minutes: number;
  completed_minutes: number;
  remaining_minutes: number;
  next_action: string | null;
  risk_score: number;
  risk_level: RiskLevel;
  last_risk_calculation_at: string | null;
  last_reminded_at: string | null;
  reminder_count: number;
  snoozed_until: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  metadata: Record<string, unknown>;
}
export interface ParsedCommitment {
  title: string;
  description?: string;
  project: string | null;
  commitmentType: Commitment["commitment_type"];
  contactName: string | null;
  organization: string | null;
  deadline: string | null;
  checkInAt: string | null;
  estimatedMinutes: number | null;
  priority: Priority;
  nextAction: string | null;
  confidence: number;
  inferredFields: string[];
  warnings: string[];
}
export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string;
  color: string;
  archived: boolean;
  created_at: string;
}
export interface Contact {
  id: string;
  user_id: string;
  name: string;
  organization: string;
  email: string;
  telegram: string;
  notes: string;
}
export interface WorkSession {
  id: string;
  user_id: string;
  commitment_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number;
  notes: string;
}
export interface Reminder {
  id: string;
  user_id: string;
  commitment_id: string | null;
  scheduled_for: string;
  type: string;
  status: "pending" | "sending" | "sent" | "failed";
  sent_at: string | null;
  provider: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
}
export interface IntegrationAccount {
  id: string;
  user_id: string;
  provider: "telegram" | "google";
  connected: boolean;
  metadata: Record<string, unknown>;
}
export interface DailyReview {
  id: string;
  user_id: string;
  date: string;
  planned_minutes: number;
  completed_minutes: number;
  completed_count: number;
  overdue_count: number;
  summary: string;
  created_at: string;
}
export interface ActivityEvent {
  id: string;
  user_id: string;
  commitment_id: string | null;
  type: string;
  message: string;
  created_at: string;
}
export interface CalendarEvent {
  id: string;
  user_id: string;
  title: string;
  start: string;
  end: string;
  source: "local" | "google" | "focus";
  commitment_id: string | null;
  external_id: string | null;
}
export interface Candidate {
  id: string;
  user_id: string;
  email_id: string;
  subject: string;
  sender: string;
  body: string;
  parsed: ParsedCommitment | null;
  status: "pending" | "accepted" | "ignored";
  created_at: string;
}
export interface UserSettings {
  name: string;
  timezone: string;
  workday_start: string;
  workday_end: string;
  sleep_start: string;
  sleep_end: string;
  meal_blocks: { start: string; end: string; label: string }[];
  max_deep_work_minutes: number;
  break_minutes: number;
  focus_block_minutes: number;
  default_task_minutes: number;
  telegram_enabled: boolean;
  briefing_time: string;
  review_time: string;
  risk_alerts: boolean;
  check_in_alerts: boolean;
  calendar_id: string;
  calendar_write_enabled: boolean;
  gmail_mining_enabled: boolean;
  gmail_scan_minutes: number;
  theme: "light" | "dark" | "system";
}
export interface AppState {
  version: number;
  user_id: string;
  records: CapturedRecord[];
  commitments: Commitment[];
  projects: Project[];
  contacts: Contact[];
  sessions: WorkSession[];
  reminders: Reminder[];
  integrations: IntegrationAccount[];
  reviews: DailyReview[];
  activity: ActivityEvent[];
  calendar_events: CalendarEvent[];
  candidates: Candidate[];
  settings: UserSettings;
}
export interface TimeWindow {
  start: string;
  end: string;
}
export interface RiskResult {
  score: number;
  level: RiskLevel;
  explanation: string[];
  pressure: number;
  availableMinutes: number;
}
export interface PlanBlock {
  commitment_id: string;
  title: string;
  start: string;
  end: string;
  minutes: number;
}
export interface DailyPlan {
  blocks: PlanBlock[];
  unscheduled: { commitment_id: string; minutes: number; reason: string }[];
  capacityMinutes: number;
  requiredMinutes: number;
  deficitMinutes: number;
}
