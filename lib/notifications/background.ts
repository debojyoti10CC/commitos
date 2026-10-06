import { formatInTimeZone } from "date-fns-tz";
import { mutateState, readState } from "@/lib/db/repository";
import { scanGmail } from "@/lib/integrations/gmail";
import { eveningReview, logActivity } from "@/lib/services";
/** Cron-only optional jobs use durable per-user claims and the user's scan/review preferences. */
export async function runBackgroundJobs(userId: string) {
  const state = await readState(userId);
  const now = new Date();
  const day = formatInTimeZone(now, state.settings.timezone, "yyyy-MM-dd");
  const time = formatInTimeZone(now, state.settings.timezone, "HH:mm");
  if (
    time >= state.settings.review_time &&
    !state.reviews.some((r) => r.date === day)
  )
    await eveningReview(userId);
  if (
    !state.settings.gmail_mining_enabled ||
    !state.integrations.some((i) => i.provider === "google" && i.connected)
  )
    return;
  let claimed = false;
  await mutateState(userId, (s) => {
    claimed = false;
    const last = s.activity.find((e) => e.type === "gmail_scan_started");
    if (
      last &&
      Date.parse(last.created_at) >
        now.getTime() - s.settings.gmail_scan_minutes * 60000
    )
      return;
    logActivity(s, "gmail_scan_started", "Scheduled Gmail scan", null, now);
    claimed = true;
  });
  if (!claimed) return;
  try {
    const candidates = await scanGmail(userId);
    await mutateState(userId, (s) => {
      for (const candidate of candidates)
        if (!s.candidates.some((c) => c.email_id === candidate.email_id))
          s.candidates.push(candidate);
      logActivity(
        s,
        "gmail_scanned",
        `${candidates.length} candidates from scheduled scan`,
        null,
        now,
      );
    });
  } catch {
    await mutateState(userId, (s) => {
      logActivity(
        s,
        "gmail_scan_failed",
        "Gmail unavailable. Reconnect Google or retry from Inbox.",
        null,
        now,
      );
    });
  }
}
