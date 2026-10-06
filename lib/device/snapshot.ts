import type { AppState, Commitment, RiskLevel, WorkSession } from "../types";
import {
  calculateRemainingEffort,
  calculateRiskScore,
  needsInterpretationReview,
  rankCommitments,
} from "../risk/engine";
import { generateDailyPlan } from "../scheduling/planner";
import {
  formatMinutes,
  isValidInstant,
  localDate,
  MINUTE,
} from "../scheduling/time";

export interface DeskTask {
  id: string;
  title: string;
  project: string | null;
  status: Commitment["status"];
  deadline: string | null;
  remaining_minutes: number;
  estimated_minutes: number;
  progress_percent: number;
  risk: { score: number; level: RiskLevel; explanation: string[] };
}

export interface DeskSnapshot {
  version: 1;
  state_version: number;
  server_time: string;
  timezone: string;
  local_date: string;
  now: DeskTask | null;
  next: DeskTask[];
  timer: {
    session_id: string;
    commitment_id: string;
    started_at: string;
    elapsed_seconds: number;
  } | null;
  capacity: {
    capacityMinutes: number;
    requiredMinutes: number;
    deficitMinutes: number;
    utilization: number;
    signal: "green" | "yellow" | "red" | "flashing_red";
    reason: string;
  };
  risk_counts: {
    total: number;
    attention: number;
    high: number;
    critical: number;
    impossible: number;
    near_high: number;
    near_critical: number;
    near_impossible: number;
  };
}

const roundMinutes = (minutes: number) =>
  Math.round(Math.max(0, minutes) * 100) / 100;
function validRunningSession(
  session: WorkSession,
  state: AppState,
  now: Date,
): boolean {
  const c = state.commitments.find((item) => item.id === session.commitment_id);
  return (
    !session.ended_at &&
    isValidInstant(session.started_at) &&
    Date.parse(session.started_at) <= now.getTime() &&
    c?.status === "in_progress" &&
    !needsInterpretationReview(c)
  );
}
function isNear(c: Commitment, now: Date): boolean {
  if (
    isValidInstant(c.deadline) &&
    Date.parse(c.deadline) <= now.getTime() + 24 * 60 * MINUTE
  )
    return true;
  if (!isValidInstant(c.check_in_at)) return false;
  const checkIn = Date.parse(c.check_in_at);
  const completed =
    typeof c.metadata.check_in_completed_at === "string"
      ? Date.parse(c.metadata.check_in_completed_at)
      : 0;
  return !(completed >= checkIn) && checkIn <= now.getTime() + 60 * MINUTE;
}

/** A read-only, bounded projection for browser desk mode and small physical displays. */
export function buildDeskSnapshot(
  state: AppState,
  now = new Date(),
): DeskSnapshot {
  const running = state.sessions
    .filter((session) => validRunningSession(session, state, now))
    .sort(
      (a, b) =>
        Date.parse(b.started_at) - Date.parse(a.started_at) ||
        a.id.localeCompare(b.id),
    );
  // All open intervals end at now. Taking the longest interval per task unions legacy
  // overlapping sessions instead of crediting the same elapsed work twice.
  const liveMinutes = new Map<string, number>();
  for (const session of running)
    liveMinutes.set(
      session.commitment_id,
      Math.max(
        liveMinutes.get(session.commitment_id) ?? 0,
        (now.getTime() - Date.parse(session.started_at)) / MINUTE,
      ),
    );
  const projected: AppState = {
    ...state,
    commitments: state.commitments.map((c) => {
      const credit = liveMinutes.get(c.id) ?? 0;
      return {
        ...c,
        completed_minutes: roundMinutes(c.completed_minutes + credit),
        remaining_minutes: roundMinutes(calculateRemainingEffort(c) - credit),
      };
    }),
  };
  // Sessions stay unchanged, so capacity accounts for the actual elapsed interval
  // once through workspaceEvents, separately from this display-only effort credit.
  const active = running[0] ?? null;
  const ranked = rankCommitments(projected, now);
  const current = active
    ? (projected.commitments.find((c) => c.id === active.commitment_id) ??
      ranked[0] ??
      null)
    : (ranked[0] ?? null);
  const task = (c: Commitment): DeskTask => {
    const risk = calculateRiskScore(c, projected, now);
    const explanation =
      risk.explanation.length > 4
        ? [
            ...risk.explanation.slice(0, 3),
            risk.explanation[risk.explanation.length - 1],
          ]
        : risk.explanation;
    return {
      id: c.id,
      title: c.title,
      project: c.project,
      status: c.status,
      deadline: c.deadline,
      remaining_minutes: c.remaining_minutes,
      estimated_minutes: c.estimated_minutes,
      progress_percent:
        c.estimated_minutes > 0
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round((c.completed_minutes / c.estimated_minutes) * 100),
              ),
            )
          : 0,
      risk: { score: risk.score, level: risk.level, explanation },
    };
  };
  const localDay = localDate(now, projected.settings.timezone);
  const plan = generateDailyPlan(projected, localDay, now);
  const counts: DeskSnapshot["risk_counts"] = {
    total: 0,
    attention: 0,
    high: 0,
    critical: 0,
    impossible: 0,
    near_high: 0,
    near_critical: 0,
    near_impossible: 0,
  };
  let nearAttention = 0;
  for (const c of projected.commitments) {
    if (
      ["done", "cancelled"].includes(c.status) ||
      needsInterpretationReview(c)
    )
      continue;
    counts.total++;
    const risk = calculateRiskScore(c, projected, now);
    if (risk.level !== "safe") counts[risk.level]++;
    if (isNear(c, now)) {
      if (risk.level === "attention") nearAttention++;
      if (risk.level === "high") counts.near_high++;
      if (risk.level === "critical") counts.near_critical++;
      if (risk.level === "impossible") counts.near_impossible++;
    }
  }
  const utilization =
    plan.capacityMinutes > 0
      ? Math.min(1, plan.requiredMinutes / plan.capacityMinutes)
      : plan.requiredMinutes > 0
        ? 1
        : 0;
  let signal: DeskSnapshot["capacity"]["signal"] = "green";
  let reason = "Today’s workload fits within your remaining capacity.";
  if (plan.deficitMinutes > 0) {
    signal = "flashing_red";
    reason = `${formatMinutes(plan.deficitMinutes)} of due work cannot fit today. Reduce scope or renegotiate.`;
  } else if (counts.near_impossible > 0) {
    signal = "flashing_red";
    reason = `${counts.near_impossible} imminent commitment${counts.near_impossible === 1 ? "" : "s"} cannot fit before the deadline.`;
  } else if (counts.near_high + counts.near_critical > 0) {
    signal = "red";
    reason = "A nearby deadline needs your attention now.";
  } else if (
    nearAttention > 0 ||
    (plan.requiredMinutes > 0 && utilization >= 0.8)
  ) {
    signal = "yellow";
    reason =
      nearAttention > 0
        ? "A nearby commitment needs attention."
        : "Today’s required work is approaching your remaining capacity.";
  }
  return {
    version: 1,
    state_version: state.version,
    server_time: now.toISOString(),
    timezone: state.settings.timezone,
    local_date: localDay,
    now: current ? task(current) : null,
    next: ranked
      .filter((c) => c.id !== current?.id)
      .slice(0, 3)
      .map(task),
    timer: active
      ? {
          session_id: active.id,
          commitment_id: active.commitment_id,
          started_at: active.started_at,
          elapsed_seconds: Math.max(
            0,
            Math.floor((now.getTime() - Date.parse(active.started_at)) / 1000),
          ),
        }
      : null,
    capacity: {
      capacityMinutes: plan.capacityMinutes,
      requiredMinutes: plan.requiredMinutes,
      deficitMinutes: plan.deficitMinutes,
      utilization: Math.round(utilization * 1000) / 1000,
      signal,
      reason,
    },
    risk_counts: counts,
  };
}
