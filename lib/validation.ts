import { z } from "zod";
import { PRIORITIES, STATUSES, TYPES } from "./types";
const nullableDate = z.iso.datetime({ offset: true }).nullable();
const safeUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      return ["https:", "http:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "Use an http or https URL")
  .nullable();
export const commitmentInput = z.object({
  title: z.string().trim().min(1).max(250),
  description: z.string().max(10000).default(""),
  project: z.string().max(100).nullable().default(null),
  commitment_type: z.enum(TYPES).default("other"),
  contact_name: z.string().max(150).nullable().default(null),
  organization: z.string().max(150).nullable().default(null),
  source: z
    .enum(["manual", "voice", "telegram", "gmail", "device"])
    .default("manual"),
  source_reference: z.string().max(500).nullable().default(null),
  source_url: safeUrl.default(null),
  status: z.enum(STATUSES).default("inbox"),
  priority: z.enum(PRIORITIES).default("medium"),
  deadline: nullableDate.default(null),
  check_in_at: nullableDate.default(null),
  estimated_minutes: z.number().int().min(1).max(525600).default(30),
  next_action: z.string().max(1000).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export const commitmentPatch = commitmentInput
  .omit({ source: true, source_reference: true, metadata: true })
  .partial();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const settingsPatch = z
  .object({
    name: z.string().trim().min(1).max(100),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone"),
    workday_start: clock,
    workday_end: clock,
    sleep_start: clock,
    sleep_end: clock,
    meal_blocks: z
      .array(z.object({ start: clock, end: clock, label: z.string().max(100) }))
      .max(8),
    max_deep_work_minutes: z.number().int().min(30).max(1440),
    break_minutes: z.number().int().min(0).max(120),
    focus_block_minutes: z.number().int().min(15).max(240),
    default_task_minutes: z.number().int().min(1).max(1440),
    telegram_enabled: z.boolean(),
    briefing_time: clock,
    review_time: clock,
    risk_alerts: z.boolean(),
    check_in_alerts: z.boolean(),
    calendar_id: z.string().min(1).max(300),
    calendar_write_enabled: z.boolean(),
    gmail_mining_enabled: z.boolean(),
    gmail_scan_minutes: z.number().int().min(15).max(10080),
    theme: z.enum(["light", "dark", "system"]),
  })
  .partial();
export const calendarInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  })
  .refine(
    (v) => new Date(v.end) > new Date(v.start),
    "Event end must follow start",
  );
