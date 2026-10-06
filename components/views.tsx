"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CalendarDays,
  Clock,
  Plus,
  Sun,
  ShieldAlert,
  Sparkles,
  Mail,
  RefreshCw,
  FolderKanban,
  Users,
  Search,
  CheckCheck,
  Play,
  Trash2,
  Send,
  Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";
import type {
  AppState,
  DailyPlan,
  Commitment,
  CalendarEvent,
  Project,
  Contact,
} from "@/lib/types";
import { rankCommitments, calculateRiskScore } from "@/lib/risk/engine";
import { generateDailyPlan } from "@/lib/scheduling/planner";
import { addLocalDays, dayBounds, zonedDate } from "@/lib/scheduling/time";
import { calculateAvailableTime } from "@/lib/scheduling/capacity";
import { useApp } from "./app-provider";
import { Button, Empty, Field, Modal, PageHeading, cn } from "./ui";
import { Capture } from "./capture";
import {
  CommitmentActions,
  CommitmentRow,
  RiskBadge,
} from "./commitment-controls";
import {
  clockTime,
  dateLabel,
  duration,
  fromInput,
  inputDate,
  localDay,
  tomorrowDeadline,
} from "./format";
function SectionHeading({
  title,
  count,
  link,
  description,
}: {
  title: string;
  count?: number;
  link?: string;
  description?: string;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>
          {title}
          {count !== undefined && <span>{count}</span>}
        </h2>
        {description && <p>{description}</p>}
      </div>
      {link && (
        <Link href={link}>
          View all <ArrowUpRight size={14} />
        </Link>
      )}
    </div>
  );
}
function monogram(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
function Capacity({
  plan,
  compact = false,
}: {
  plan: DailyPlan;
  compact?: boolean;
}) {
  const ratio = plan.capacityMinutes
    ? Math.min(100, (plan.requiredMinutes / plan.capacityMinutes) * 100)
    : 100;
  return (
    <div className={cn("capacity-panel", compact && "capacity-compact")}>
      <div className="eyebrow">
        TODAY’S CAPACITY <span>● LIVE</span>
      </div>
      <div className="capacity-numbers">
        <strong>{duration(plan.requiredMinutes)}</strong>
        <span>/ {duration(plan.capacityMinutes)} available</span>
      </div>
      <div className="capacity-track">
        <span
          style={{ width: `${ratio}%` }}
          className={plan.deficitMinutes > 0 ? "overloaded" : ""}
        />
      </div>
      <div className="capacity-axis">
        <span>Required work</span>
        <span>Available time</span>
      </div>
      {plan.deficitMinutes > 0 ? (
        <div className="capacity-warning">
          <ShieldAlert size={17} />
          <p>
            <strong>{duration(plan.deficitMinutes)} over capacity</strong>
            <span>Something needs more time or a new deadline.</span>
          </p>
        </div>
      ) : (
        <div className="capacity-safe">
          <Check size={16} />
          {duration(
            Math.max(0, plan.capacityMinutes - plan.requiredMinutes),
          )}{" "}
          of breathing room
        </div>
      )}
    </div>
  );
}
function Timeline({
  state,
  plan,
  full = false,
}: {
  state: AppState;
  plan: DailyPlan;
  full?: boolean;
}) {
  const tz = state.settings.timezone;
  const day = localDay(tz);
  const focusEvents: CalendarEvent[] = plan.blocks.map((block, index) => ({
    id: `preview-${index}`,
    user_id: state.user_id,
    title: block.title,
    start: block.start,
    end: block.end,
    source: "focus",
    commitment_id: block.commitment_id,
    external_id: null,
  }));
  const free = full
    ? calculateAvailableTime(
        day,
        { ...state.settings, max_deep_work_minutes: 1440 },
        [
          ...state.calendar_events.filter((event) => event.source !== "focus"),
          ...focusEvents,
        ],
      )
        .filter(
          (window) =>
            (Date.parse(window.end) - Date.parse(window.start)) / 60000 >= 15,
        )
        .map((window, index) => ({
          id: `free-${index}`,
          title: "Open time · breathing room",
          start: window.start,
          end: window.end,
          external: true,
          commitment: null as Commitment | null,
          source: "free",
        }))
    : [];
  const meals = full
    ? state.settings.meal_blocks.map((meal, index) => ({
        id: `meal-${index}`,
        title: meal.label,
        start: zonedDate(day, meal.start, tz).toISOString(),
        end: zonedDate(
          meal.end <= meal.start ? addLocalDays(day, 1) : day,
          meal.end,
          tz,
        ).toISOString(),
        external: true,
        commitment: null as Commitment | null,
        source: "meal",
      }))
    : [];
  const events = [
    ...free,
    ...meals,
    ...state.calendar_events
      .filter(
        (e) =>
          localDay(tz, new Date(e.start)) === localDay(tz) &&
          e.source !== "focus",
      )
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        external: true,
        commitment: null as Commitment | null,
        source: e.source,
      })),
    ...plan.blocks.map((b, i) => ({
      id: `${b.commitment_id}-${i}`,
      title: b.title,
      start: b.start,
      end: b.end,
      external: false,
      commitment:
        state.commitments.find((c) => c.id === b.commitment_id) || null,
      source: "focus",
    })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  return (
    <div className={cn("timeline", full && "timeline-full")}>
      {events.length === 0 ? (
        <p className="muted">
          No blocks yet. Generate a plan to make room for your work.
        </p>
      ) : (
        events.slice(0, full ? 99 : 5).map((event) => (
          <div
            className={cn(
              "timeline-item",
              event.external && "timeline-external",
              event.source === "free" && "timeline-free",
              event.source === "meal" && "timeline-break",
            )}
            key={event.id}
          >
            <div className="timeline-time">
              {clockTime(event.start, tz)}
              {full && <small>{clockTime(event.end, tz)}</small>}
            </div>
            <div className="timeline-line">
              <span />
            </div>
            <div className="timeline-content">
              <small>
                {event.source === "free"
                  ? "FREE WINDOW"
                  : event.source === "meal"
                    ? "PROTECTED BREAK"
                    : event.external
                      ? event.source === "google"
                        ? "GOOGLE CALENDAR"
                        : "CALENDAR EVENT"
                      : "FOCUS BLOCK"}
              </small>
              <strong>{event.title}</strong>
              <p>
                {duration(
                  (new Date(event.end).getTime() -
                    new Date(event.start).getTime()) /
                    60000,
                )}
                {!full && ` · until ${clockTime(event.end, tz)}`}
              </p>
              {full && event.commitment && (
                <CommitmentActions commitment={event.commitment} full />
              )}
            </div>
          </div>
        ))
      )}
      {!full && events.length > 5 && (
        <Link href="/today" className="timeline-more">
          + {events.length - 5} more blocks <ArrowRight size={13} />
        </Link>
      )}
    </div>
  );
}
function useWorkspace() {
  const { state, ...app } = useApp();
  return { state: state!, ...app };
}
export function DashboardView() {
  const { state, setCaptureOpen, mutate } = useWorkspace();
  const tz = state.settings.timezone;
  const ranked = useMemo(() => rankCommitments(state), [state]);
  const plan = useMemo(
    () => generateDailyPlan(state, localDay(tz)),
    [state, tz],
  );
  const now = ranked[0];
  const next = ranked.slice(1, 4);
  const wins = ranked.filter((c) => c.remaining_minutes <= 15);
  const risks = state.commitments.filter(
    (c) =>
      !["done", "cancelled"].includes(c.status) &&
      ["high", "critical", "impossible"].includes(
        calculateRiskScore(c, state).level,
      ),
  );
  const risk = now ? calculateRiskScore(now, state) : null;
  const active = state.commitments.filter(
    (c) => !["done", "cancelled"].includes(c.status),
  );
  const due = active.filter(
    (c) => c.deadline && localDay(tz, new Date(c.deadline)) === localDay(tz),
  ).length;
  const date = new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  }).format(new Date());
  const greeting = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone: tz,
  }).format(new Date());
  const greet =
    Number(greeting) < 12
      ? "Good morning"
      : Number(greeting) < 17
        ? "Good afternoon"
        : "Good evening";
  return (
    <>
      <PageHeading
        eyebrow={date.toUpperCase()}
        title={`${greet}, ${state.settings.name.split(" ")[0] || "there"}.`}
        description="A clear head. A realistic day. One commitment at a time."
        actions={
          <Button
            onClick={async () => {
              const result = await mutate("/api/planning/generate", {
                day: localDay(tz),
                apply: true,
              });
              if (result) toast.success("Daily plan generated");
            }}
          >
            <Sparkles size={16} />
            Plan my day
          </Button>
        }
      />
      <Capture />
      <div className="overview-stats">
        <div>
          <span className="stat-number">{active.length}</span>
          <span>Active commitments</span>
        </div>
        <div>
          <span className="stat-number">{due.toString().padStart(2, "0")}</span>
          <span>Due today</span>
        </div>
        <div>
          <span className="stat-number warning-text">
            {risks.length.toString().padStart(2, "0")}
          </span>
          <span>Need attention</span>
        </div>
        <div className="stat-message">
          <span className="status-dot" />
          Your next move is clear.
        </div>
      </div>
      <div className="dashboard-grid">
        <div className="dashboard-primary">
          <div className="now-panel">
            <div className="now-heading">
              <span className="now-label">
                <span /> YOUR NEXT MOVE
              </span>
              <span className="now-counter">
                01 / {String(Math.max(1, ranked.length)).padStart(2, "0")}
              </span>
            </div>
            {now ? (
              <>
                <div className="now-project">
                  <span className="project-dot" />
                  {now.project || "PERSONAL"}
                  <span> / </span>
                  {now.commitment_type.replace("_", " ")}
                </div>
                <h2>{now.title}</h2>
                <p className="now-next-action">
                  {now.next_action ||
                    "Open what you need and take the first concrete step."}
                </p>
                <div className="now-metrics">
                  <div>
                    <Clock size={15} />
                    <span>
                      <small>TIME NEEDED</small>
                      <strong>{duration(now.remaining_minutes)}</strong>
                    </span>
                  </div>
                  <div>
                    <CalendarDays size={15} />
                    <span>
                      <small>DEADLINE</small>
                      <strong>{dateLabel(now.deadline, tz)}</strong>
                    </span>
                  </div>
                  {risk && <RiskBadge level={risk.level} />}
                </div>
                <div className="now-bottom">
                  <CommitmentActions commitment={now} full />
                  <span className="now-note">Small start. Real progress.</span>
                </div>
                {risk && risk.level !== "safe" && (
                  <div className="now-risk-note">
                    <ShieldAlert size={14} />
                    {risk.explanation[0]}
                  </div>
                )}
              </>
            ) : (
              <Empty
                title="You have a clear slate"
                description="Capture a promise or something you need to finish."
                action={
                  <Button
                    variant="primary"
                    onClick={() => setCaptureOpen(true)}
                  >
                    <Plus size={16} />
                    Capture commitment
                  </Button>
                }
              />
            )}
          </div>
          <section className="next-section">
            <SectionHeading
              title="Up next"
              count={next.length}
              link="/commitments"
              description="The next few moves, in priority order."
            />
            {next.length ? (
              next.map((c, i) => (
                <CommitmentRow key={c.id} commitment={c} index={i + 1} />
              ))
            ) : (
              <p className="muted section-empty">
                Nothing else is waiting. Enjoy the breathing room.
              </p>
            )}
          </section>
          <section className="quick-section">
            <SectionHeading
              title="Small effort. Big relief."
              count={wins.length}
              description="Clear these in 15 minutes or less."
            />
            {wins.length ? (
              <div className="quick-win-grid">
                {wins.slice(0, 3).map((c) => (
                  <div className="quick-win" key={c.id}>
                    <span>
                      <Clock size={13} />
                      {duration(c.remaining_minutes)}
                    </span>
                    <h3>{c.title}</h3>
                    <div>
                      <small>{c.project || "Personal"}</small>
                      <Button
                        className="icon-button"
                        variant="ghost"
                        aria-label={`Complete ${c.title}`}
                        onClick={() =>
                          void mutate(`/api/commitments/${c.id}/complete`).then(
                            (r) => r && toast.success("Quick win completed"),
                          )
                        }
                      >
                        <ArrowUpRight size={18} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted section-empty">
                No quick wins right now. Focus on your next move.
              </p>
            )}
          </section>
          {risks.length > 0 && (
            <section className="risk-section">
              <SectionHeading
                title="Keep an eye on these"
                count={risks.length}
              />
              {risks.slice(0, 2).map((c) => (
                <div className="risk-line" key={c.id}>
                  <ShieldAlert size={17} />
                  <div>
                    <strong>{c.title}</strong>
                    <p>{calculateRiskScore(c, state).explanation[0]}</p>
                  </div>
                  <CommitmentActions commitment={c} />
                </div>
              ))}
            </section>
          )}
        </div>
        <aside className="day-rail">
          <Capacity plan={plan} />
          <div className="day-timeline">
            <div className="section-heading">
              <h2>Your day, mapped</h2>
              <Link href="/today">
                <ArrowUpRight size={15} />
              </Link>
            </div>
            <p className="rail-subtitle">A plan, with space to be human.</p>
            <Timeline state={state} plan={plan} />
            <Link className="button button-secondary full-button" href="/today">
              Open today <ArrowRight size={15} />
            </Link>
          </div>
          <div className="gentle-note">
            <div className="note-symbol">✳</div>
            <p>
              Protect your attention.
              <br />
              <strong>The rest can wait its turn.</strong>
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
export function TodayView() {
  const { state, mutate } = useWorkspace();
  const tz = state.settings.timezone,
    plan = useMemo(() => generateDailyPlan(state, localDay(tz)), [state, tz]);
  return (
    <>
      <PageHeading
        eyebrow="EXECUTION"
        title="Make today executable."
        description="Your commitments, arranged around the time you actually have."
        actions={
          <Button
            variant="primary"
            onClick={async () => {
              const result = await mutate("/api/planning/generate", {
                day: localDay(tz),
                apply: true,
              });
              if (result) toast.success("Plan saved locally");
            }}
          >
            <Sparkles size={16} />
            Rebuild plan
          </Button>
        }
      />
      <div className="today-grid">
        <section className="surface">
          <div className="section-heading">
            <h2>
              {new Intl.DateTimeFormat("en", {
                weekday: "long",
                month: "short",
                day: "numeric",
                timeZone: tz,
              }).format(new Date())}
            </h2>
            <span className="muted">{tz}</span>
          </div>
          <div className="timeline-legend">
            <span>
              <i />
              Focus block
            </span>
            <span>
              <i className="external" />
              Calendar event
            </span>
            <span>
              <i className="free" />
              Free time & breaks
            </span>
          </div>
          <Timeline state={state} plan={plan} full />
        </section>
        <aside>
          <Capacity plan={plan} />
          <div className="surface unscheduled">
            <SectionHeading
              title="Needs a decision"
              count={plan.unscheduled.length}
            />
            {plan.unscheduled.length ? (
              plan.unscheduled.map((u, i) => {
                const c = state.commitments.find(
                  (c) => c.id === u.commitment_id,
                );
                return c ? (
                  <div
                    className="unscheduled-item"
                    key={`${u.commitment_id}-${i}`}
                  >
                    <strong>{c.title}</strong>
                    <p>
                      {duration(u.minutes)} · {u.reason}
                    </p>
                    <CommitmentActions commitment={c} />
                  </div>
                ) : null;
              })
            ) : (
              <p className="muted">
                Your plan fits. Start the first block when you're ready.
              </p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
export function CommitmentsView() {
  const { state, setCaptureOpen } = useWorkspace();
  const [search, setSearch] = useState(() =>
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("search") || ""
        : "",
    ),
    [status, setStatus] = useState("active"),
    [project, setProject] = useState("all"),
    [priority, setPriority] = useState("all"),
    [risk, setRisk] = useState("all"),
    [type, setType] = useState("all"),
    [overdue, setOverdue] = useState(
      () =>
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("filter") === "overdue",
    );
  const commitments = state.commitments
    .filter(
      (c) =>
        (status === "all" || status === "active"
          ? !["done", "cancelled"].includes(c.status) || status === "all"
          : c.status === status) &&
        (project === "all" || c.project === project) &&
        (priority === "all" || c.priority === priority) &&
        (risk === "all" || calculateRiskScore(c, state).level === risk) &&
        (type === "all" || c.commitment_type === type) &&
        (!overdue || (!!c.deadline && new Date(c.deadline) < new Date())) &&
        `${c.title} ${c.description} ${c.contact_name || ""} ${c.organization || ""} ${c.project || ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => (a.deadline || "z").localeCompare(b.deadline || "z"));
  return (
    <>
      <PageHeading
        eyebrow="YOUR OPERATIONS"
        title="Every promise, in one place."
        description="Search, adjust, and follow through. Nothing slips through the cracks."
        actions={
          <Button variant="primary" onClick={() => setCaptureOpen(true)}>
            <Plus size={16} />
            Capture commitment
          </Button>
        }
      />
      <div className="list-toolbar">
        <div className="filter-search">
          <Search size={16} />
          <input
            aria-label="Search commitments"
            placeholder="Search commitments, people, notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {[
            "active",
            "all",
            "inbox",
            "scheduled",
            "in_progress",
            "waiting",
            "blocked",
            "done",
            "cancelled",
          ].map((s) => (
            <option key={s} value={s}>
              {s === "active"
                ? "Active commitments"
                : s === "all"
                  ? "All statuses"
                  : s.replace("_", " ")}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="all">All projects</option>
          {Array.from(
            new Set(state.commitments.map((c) => c.project).filter(Boolean)),
          ).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>
      <div className="secondary-filters">
        <select
          aria-label="Filter priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          <option value="all">Any priority</option>
          {["low", "medium", "high", "critical"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          aria-label="Filter risk"
          value={risk}
          onChange={(e) => setRisk(e.target.value)}
        >
          <option value="all">Any risk</option>
          {["safe", "attention", "high", "critical", "impossible"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          aria-label="Filter type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">Any type</option>
          {[
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
          ].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={overdue}
            onChange={(e) => setOverdue(e.target.checked)}
          />
          Overdue only
        </label>
        <span>{commitments.length} commitments</span>
      </div>
      <section className="surface commitment-list">
        <div className="list-header">
          <span>COMMITMENT</span>
          <span>EFFORT</span>
          <span>DEADLINE RISK</span>
        </div>
        {commitments.length ? (
          commitments.map((c) => <CommitmentRow key={c.id} commitment={c} />)
        ) : (
          <Empty
            title="Nothing matches"
            description="Try another filter or capture your next commitment."
            action={
              <Button
                onClick={() => {
                  setSearch("");
                  setStatus("all");
                  setProject("all");
                  setPriority("all");
                  setRisk("all");
                  setType("all");
                  setOverdue(false);
                }}
              >
                Clear filters
              </Button>
            }
          />
        )}
      </section>
    </>
  );
}
export function InboxView() {
  const { state, mutate, capabilities, setCaptureOpen } = useWorkspace();
  const candidates = state.candidates.filter((c) => c.status === "pending"),
    inbox = state.commitments.filter((c) => c.status === "inbox"),
    googleConnected = state.integrations.some(
      (i) => i.provider === "google" && i.connected,
    );
  return (
    <>
      <PageHeading
        eyebrow="CAPTURE → UNDERSTAND"
        title="A lighter head starts here."
        description="A holding space for new commitments and things detected in your email."
        actions={
          <>
            <Button
              disabled={!googleConnected}
              onClick={async () => {
                const result = await mutate("/api/gmail/scan");
                if (result) toast.success("Inbox scan complete");
              }}
            >
              <RefreshCw size={15} />
              Scan Gmail
            </Button>
            <Button variant="primary" onClick={() => setCaptureOpen(true)}>
              <Plus size={16} />
              Capture
            </Button>
          </>
        }
      />
      <Capture />
      {!googleConnected && (
        <div className="inbox-integration-note">
          <Mail size={16} />
          <p>
            Gmail is not connected. Email mining starts after you connect Google
            and enable it in Settings.
          </p>
          <Link href="/settings">
            Connect Google <ArrowUpRight size={14} />
          </Link>
        </div>
      )}
      <section className="section-spaced">
        <SectionHeading
          title="Detected commitments"
          count={candidates.length}
          description="You decide what becomes a commitment."
        />
        {candidates.length ? (
          <div className="candidate-grid">
            {candidates.map((c) => (
              <article className="candidate-card" key={c.id}>
                <div className="candidate-source">
                  <Mail size={15} />
                  <span>{c.sender}</span>
                  <span className="tag">
                    {Math.round((c.parsed?.confidence || 0) * 100)}% confidence
                  </span>
                </div>
                <h3>{c.parsed?.title || c.subject}</h3>
                <p>{c.body.slice(0, 250)}</p>
                {c.parsed?.deadline && (
                  <span className="candidate-deadline">
                    <CalendarDays size={13} />
                    {dateLabel(c.parsed.deadline, state.settings.timezone)}
                  </span>
                )}
                <div className="candidate-actions">
                  <Button
                    variant="primary"
                    onClick={() =>
                      void mutate(`/api/inbox/${c.id}`, {
                        action: "accept",
                      }).then((r) => r && toast.success("Commitment accepted"))
                    }
                  >
                    <Check size={15} />
                    Accept
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void mutate(`/api/inbox/${c.id}`, { action: "ignore" })
                    }
                  >
                    Ignore
                  </Button>
                  {/^[a-zA-Z0-9_-]+$/.test(c.email_id) && (
                    <a
                      className="email-link"
                      href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(c.email_id)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open email <ArrowUpRight size={13} />
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="Inbox, clear."
            description="New email candidates will wait here for your approval."
          />
        )}
      </section>
      <section className="section-spaced">
        <SectionHeading title="Captured & unplanned" count={inbox.length} />
        <div className="surface commitment-list">
          {inbox.length ? (
            inbox.map((c) => (
              <div key={c.id} className="inbox-row">
                {c.metadata.needs_review === true && (
                  <span className="tag draft-tag">Review interpretation</span>
                )}
                <CommitmentRow commitment={c} />
                <Button
                  onClick={() =>
                    void mutate(
                      `/api/commitments/${c.id}`,
                      { status: "scheduled" },
                      "PATCH",
                    )
                  }
                >
                  Accept & schedule <ArrowRight size={13} />
                </Button>
              </div>
            ))
          ) : (
            <p className="muted section-empty">
              All captured commitments have been processed.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
export function ProjectsView() {
  const { state, mutate } = useWorkspace();
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [color, setColor] = useState("#111111"),
    [selected, setSelected] = useState(() =>
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("project") || ""
        : "",
    );
  const project = state.projects.find((p) => p.name === selected);
  const related = state.commitments.filter((c) => c.project === selected);
  return (
    <>
      <PageHeading
        eyebrow="WORK IN CONTEXT"
        title="The things you're building."
        description="Lightweight projects. A clear picture of what each one needs."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus size={16} />
            New project
          </Button>
        }
      />
      <div className="project-index">
        {!!state.projects.length && (
          <div className="project-index-heading" aria-hidden="true">
            <span className="directory-index">#</span>
            <span className="project-identity">Project</span>
            <span className="project-workload">Open work</span>
            <span className="project-health">Status</span>
            <span className="directory-arrow" />
          </div>
        )}
        {state.projects.map((p, index) => {
          const active = state.commitments.filter(
              (c) =>
                c.project === p.name &&
                !["done", "cancelled"].includes(c.status),
            ),
            remaining = active.reduce((sum, c) => sum + c.remaining_minutes, 0),
            atRisk = active.filter((c) =>
              ["high", "critical", "impossible"].includes(
                calculateRiskScore(c, state).level,
              ),
            );
          return (
            <button
              type="button"
              className={cn(
                "project-index-row",
                selected === p.name && "selected",
              )}
              key={p.id}
              aria-pressed={selected === p.name}
              onClick={() => setSelected(selected === p.name ? "" : p.name)}
            >
              <span className="directory-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="project-identity">
                <strong>{p.name}</strong>
                <span>
                  {p.description || "Your commitments, grouped together."}
                </span>
              </span>
              <span className="project-workload">
                <strong>{duration(remaining)}</strong>
                <span>
                  {active.length} active commitment
                  {active.length === 1 ? "" : "s"}
                </span>
              </span>
              <span
                className={cn(
                  "project-health",
                  atRisk.length > 0 && "needs-attention",
                )}
              >
                <span className="directory-health-dot" aria-hidden="true" />
                {atRisk.length
                  ? `${atRisk.length} ${atRisk.length === 1 ? "needs" : "need"} attention`
                  : "On track"}
              </span>
              <ArrowUpRight
                className="directory-arrow"
                size={18}
                aria-hidden="true"
              />
            </button>
          );
        })}
        {!state.projects.length && (
          <Empty
            title="Give your work a little context"
            description="Projects are optional. Add one when it helps."
            action={
              <Button onClick={() => setOpen(true)}>Create project</Button>
            }
          />
        )}
      </div>
      {project && (
        <section className="section-spaced project-detail">
          <SectionHeading
            title={project.name}
            count={related.length}
            description={`${related.filter((c) => c.status === "done").length} completed · ${duration(related.reduce((s, c) => s + c.completed_minutes, 0))} worked`}
          />
          <div className="surface commitment-list">
            {related.length ? (
              related.map((c) => <CommitmentRow key={c.id} commitment={c} />)
            ) : (
              <p className="muted section-empty">
                No commitments yet. Capture a task and mention {project.name}.
              </p>
            )}
          </div>
        </section>
      )}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="New project"
        description="Just a name is enough. Keep the organizing light."
      >
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await mutate("/api/projects", {
              name,
              description,
              color,
            });
            if (result) {
              setOpen(false);
              setName("");
              setDescription("");
              toast.success("Project created");
            }
          }}
        >
          <Field label="Project name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What are you working on?"
            />
          </Field>
          <Field label="Description (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="Color">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </Field>
          <Button variant="primary" type="submit">
            Create project
          </Button>
        </form>
      </Modal>
    </>
  );
}
export function PeopleView() {
  const { state, mutate } = useWorkspace();
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(() =>
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("search") || ""
        : "",
    ),
    [person, setPerson] = useState<Contact | null>(null),
    [form, setForm] = useState({
      name: "",
      organization: "",
      email: "",
      telegram: "",
      notes: "",
    });
  const contacts = state.contacts.filter((c) =>
    `${c.name} ${c.organization} ${c.email}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const related = person
    ? state.commitments.filter(
        (c) =>
          (c.contact_name?.toLowerCase() === person.name.toLowerCase() ||
            (!!person.organization &&
              c.organization?.toLowerCase() ===
                person.organization.toLowerCase())) &&
          !["done", "cancelled"].includes(c.status),
      )
    : [];
  return (
    <>
      <PageHeading
        eyebrow="FOLLOW-THROUGH IS PERSONAL"
        title="Who you're showing up for."
        description="Know what you owe, and to whom. Without searching your messages."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus size={16} />
            Add person
          </Button>
        }
      />
      <div className="people-toolbar">
        <div className="filter-search people-search">
          <Search size={16} aria-hidden="true" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people or organizations"
            aria-label="Search people"
          />
        </div>
        <span className="people-count">
          <strong>{contacts.length}</strong>{" "}
          {contacts.length === 1 ? "person" : "people"}
        </span>
      </div>
      <div className="people-directory">
        {!!contacts.length && (
          <div className="directory-heading" aria-hidden="true">
            <span className="directory-index">#</span>
            <span className="person-identity">Person / organization</span>
            <span className="person-obligations">Open commitments</span>
            <span className="person-health">Follow-through</span>
            <span className="directory-arrow" />
          </div>
        )}
        {contacts.map((c, index) => {
          const owed = state.commitments.filter(
            (task) =>
              (task.contact_name?.toLowerCase() === c.name.toLowerCase() ||
                (!!c.organization &&
                  task.organization?.toLowerCase() ===
                    c.organization.toLowerCase())) &&
              !["done", "cancelled"].includes(task.status),
          );
          const atRisk = owed.filter((task) =>
            ["high", "critical", "impossible"].includes(
              calculateRiskScore(task, state).level,
            ),
          );
          return (
            <button
              type="button"
              className="person-row"
              key={c.id}
              onClick={() => setPerson(c)}
            >
              <span className="directory-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="person-identity">
                <span className="person-avatar" aria-hidden="true">
                  {monogram(c.name)}
                </span>
                <span className="person-name">
                  <strong>{c.name}</strong>
                  <span>{c.organization || c.email || "Personal contact"}</span>
                </span>
              </span>
              <span className="person-obligations">
                <strong>{String(owed.length).padStart(2, "0")}</strong>
                <span>open commitment{owed.length === 1 ? "" : "s"}</span>
              </span>
              <span
                className={cn(
                  "person-health",
                  atRisk.length > 0 && "needs-attention",
                )}
              >
                <span className="directory-health-dot" aria-hidden="true" />
                {atRisk.length
                  ? `${atRisk.length} ${atRisk.length === 1 ? "needs" : "need"} attention`
                  : owed.length
                    ? "On track"
                    : "All caught up"}
              </span>
              <ChevronRight
                className="directory-arrow"
                size={18}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>
      {!contacts.length && (
        <Empty
          title="No people found"
          description="Add the people you make promises to, or try another search."
        />
      )}
      <Modal
        open={!!person}
        onOpenChange={(v) => !v && setPerson(null)}
        title={`What you owe ${person?.name || ""}`}
        description={person?.organization || "Open commitments"}
        wide
      >
        {person && (
          <>
            <div className="person-profile">
              <span className="person-avatar" aria-hidden="true">
                {monogram(person.name)}
              </span>
              <div>
                <h3>{person.name}</h3>
                <p>{person.organization || "Personal contact"}</p>
              </div>
              <span className="person-profile-count">
                <strong>{String(related.length).padStart(2, "0")}</strong>
                <span>open commitments</span>
              </span>
            </div>
            {(person.email || person.telegram) && (
              <dl className="person-profile-meta">
                {person.email && (
                  <div>
                    <dt>Email</dt>
                    <dd>{person.email}</dd>
                  </div>
                )}
                {person.telegram && (
                  <div>
                    <dt>Telegram</dt>
                    <dd>{person.telegram}</dd>
                  </div>
                )}
              </dl>
            )}
            <div className="person-commitments commitment-list">
              {related.length ? (
                related.map((c) => <CommitmentRow key={c.id} commitment={c} />)
              ) : (
                <Empty
                  title="You're all caught up."
                  description="No open commitments are associated with this person."
                />
              )}
            </div>
            {person.notes && (
              <div className="person-profile-notes">
                <span className="eyebrow">Notes</span>
                <p>{person.notes}</p>
              </div>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add a person"
        description="Connect your commitments with the people behind them."
      >
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await mutate("/api/contacts", form);
            if (result) {
              setOpen(false);
              setForm({
                name: "",
                organization: "",
                email: "",
                telegram: "",
                notes: "",
              });
              toast.success("Person added");
            }
          }}
        >
          {Object.entries(form).map(([key, value]) => (
            <Field
              key={key}
              label={
                key === "name"
                  ? "Name"
                  : `${key[0].toUpperCase() + key.slice(1)} (optional)`
              }
            >
              <input
                required={key === "name"}
                type={key === "email" ? "email" : "text"}
                value={value}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </Field>
          ))}
          <Button variant="primary" type="submit">
            Add person
          </Button>
        </form>
      </Modal>
    </>
  );
}
export function CalendarView() {
  const { state, mutate, capabilities } = useWorkspace();
  const tz = state.settings.timezone;
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState(""),
    [start, setStart] = useState(`${localDay(tz)}T10:00`),
    [end, setEnd] = useState(`${localDay(tz)}T11:00`),
    [preview, setPreview] = useState<DailyPlan | null>(null),
    [day, setDay] = useState(localDay(tz));
  const events = state.calendar_events
    .filter((e) => localDay(tz, new Date(e.start)) === day)
    .sort((a, b) => a.start.localeCompare(b.start));
  const google = state.integrations.find((a) => a.provider === "google");
  return (
    <>
      <PageHeading
        eyebrow="PROTECT YOUR TIME"
        title="A calendar that makes room."
        description="Hard events stay protected. Focus blocks go where your time is free."
        actions={
          <>
            <Button onClick={() => setOpen(true)}>
              <Plus size={16} />
              Add event
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                const result = await mutate<{ plan: DailyPlan }>(
                  "/api/planning/generate",
                  { day, apply: false },
                );
                if (result) setPreview(result.plan);
              }}
            >
              <Sparkles size={16} />
              Preview daily plan
            </Button>
          </>
        }
      />
      <div className="calendar-status">
        <span className={google?.connected ? "status-dot" : "neutral-dot"} />
        <strong>
          {google?.connected
            ? "Google Calendar connected"
            : "Local calendar mode"}
        </strong>
        <span>
          {google?.connected
            ? "External events are included in your capacity."
            : "Add events here. Connect Google Calendar whenever you’re ready."}
        </span>
        {google?.connected ? (
          <Button
            onClick={() =>
              void mutate("/api/integrations/google/sync").then(
                (r) => r && toast.success("Calendar synchronized"),
              )
            }
          >
            <RefreshCw size={14} />
            Sync
          </Button>
        ) : (
          <Link href="/settings">
            Connect <ArrowUpRight size={13} />
          </Link>
        )}
      </div>
      <div className="calendar-heading">
        <h2>Your schedule</h2>
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          aria-label="Choose calendar day"
        />
      </div>
      <section className="surface calendar-events">
        {events.length ? (
          events.map((event) => (
            <div
              className={cn(
                "calendar-event",
                event.source === "focus" && "calendar-focus",
              )}
              key={event.id}
            >
              <span className="calendar-event-time">
                {clockTime(event.start, tz)}
                <small>{clockTime(event.end, tz)}</small>
              </span>
              <span className="calendar-event-stripe" />
              <div>
                <span className="eyebrow">
                  {event.source === "focus"
                    ? "COMMITOS FOCUS"
                    : event.source === "google"
                      ? "GOOGLE CALENDAR"
                      : "LOCAL EVENT"}
                </span>
                <h3>{event.title}</h3>
                <p>
                  {duration(
                    (new Date(event.end).getTime() -
                      new Date(event.start).getTime()) /
                      60000,
                  )}
                </p>
              </div>
              {event.source !== "google" && (
                <Button
                  className="icon-button"
                  variant="ghost"
                  aria-label={`Delete event ${event.title}`}
                  onClick={() =>
                    void mutate(
                      `/api/calendar/events/${event.id}`,
                      undefined,
                      "DELETE",
                    )
                  }
                >
                  <Trash2 size={16} />
                </Button>
              )}
            </div>
          ))
        ) : (
          <Empty
            title="This day has room."
            description="Add a hard event or generate focus blocks around your available time."
            action={
              <Button onClick={() => setOpen(true)}>Add calendar event</Button>
            }
          />
        )}
      </section>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add calendar event"
        description="Meetings, classes, and anything that needs protected time."
      >
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await mutate("/api/calendar/events", {
              title,
              start: fromInput(start, tz),
              end: fromInput(end, tz),
            });
            if (result) {
              setOpen(false);
              setTitle("");
              toast.success("Event added locally");
            }
          }}
        >
          <Field label="Event title">
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Start">
            <input
              required
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="End">
            <input
              required
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
          <Button variant="primary" type="submit">
            Add event
          </Button>
        </form>
      </Modal>
      <Modal
        open={!!preview}
        onOpenChange={(v) => !v && setPreview(null)}
        title="Your proposed day"
        description="Review the blocks before saving. Hard events are preserved."
        wide
      >
        {preview && (
          <>
            <Capacity plan={preview} compact />
            {preview.blocks.map((b, i) => (
              <div className="plan-preview-row" key={`${b.commitment_id}-${i}`}>
                <span>
                  {clockTime(b.start, tz)} – {clockTime(b.end, tz)}
                </span>
                <strong>{b.title}</strong>
                <small>{duration(b.minutes)}</small>
              </div>
            ))}
            {preview.unscheduled.length > 0 && (
              <div className="warning-panel">
                {preview.unscheduled.length} commitments still need time. Review
                them on Today.
              </div>
            )}
            <div className="modal-footer">
              <Button
                onClick={async () => {
                  const result = await mutate("/api/planning/generate", {
                    day,
                    apply: true,
                  });
                  if (result) {
                    setPreview(null);
                    toast.success("Plan saved locally");
                  }
                }}
              >
                Save plan locally
              </Button>
              <Button
                variant="primary"
                disabled={
                  !google?.connected || !state.settings.calendar_write_enabled
                }
                onClick={async () => {
                  const saved = await mutate("/api/planning/generate", {
                    day,
                    apply: true,
                  });
                  if (saved) {
                    const result = await mutate(
                      "/api/integrations/google/write",
                    );
                    if (result) {
                      setPreview(null);
                      toast.success("Focus blocks written to Google Calendar");
                    }
                  }
                }}
              >
                <Send size={15} />
                Write to Google Calendar
              </Button>
            </div>
            {(!google?.connected || !state.settings.calendar_write_enabled) && (
              <p className="muted small">
                Connect Google and enable focus block writes in Settings to use
                calendar publishing.
              </p>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
export function ReviewView() {
  const { state, mutate } = useWorkspace();
  const tz = state.settings.timezone,
    day = localDay(tz),
    plan = generateDailyPlan(state, day),
    completed = state.commitments.filter(
      (c) => c.completed_at && localDay(tz, new Date(c.completed_at)) === day,
    ),
    unresolved = state.commitments.filter(
      (c) =>
        !["done", "cancelled"].includes(c.status) &&
        ((c.deadline && localDay(tz, new Date(c.deadline)) <= day) ||
          ["waiting", "blocked"].includes(c.status)),
    );
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);
  const [dayStart, dayEnd] = dayBounds(day, tz);
  const worked = state.sessions.reduce(
    (total, session) =>
      total +
      Math.max(
        0,
        Math.min(
          Date.parse(session.ended_at || new Date(clock).toISOString()),
          dayEnd.getTime(),
        ) - Math.max(Date.parse(session.started_at), dayStart.getTime()),
      ) /
        60000,
    0,
  );
  const baseline = state.commitments.reduce((total, c) => {
    const stored = c.metadata.planned_minutes_by_day;
    return (
      total +
      (stored &&
      typeof stored === "object" &&
      day in stored &&
      typeof (stored as Record<string, unknown>)[day] === "number"
        ? Number((stored as Record<string, unknown>)[day])
        : 0)
    );
  }, 0);
  const planned = Math.max(
    baseline,
    state.reviews.find((r) => r.date === day)?.planned_minutes || 0,
    state.calendar_events
      .filter((e) => e.source === "focus")
      .reduce(
        (sum, event) =>
          sum +
          Math.max(
            0,
            Math.min(Date.parse(event.end), dayEnd.getTime()) -
              Math.max(Date.parse(event.start), dayStart.getTime()),
          ) /
            60000,
        0,
      ),
  );
  const [summary, setSummary] = useState(""),
    [briefing, setBriefing] = useState<unknown>(null);
  const existing = state.reviews.find((r) => r.date === day);
  useEffect(() => {
    setSummary(existing?.summary || "");
  }, [existing?.id]);
  return (
    <>
      <PageHeading
        eyebrow="CLOSE THE LOOP"
        title="End the day with a clear head."
        description="Progress counts. Unfinished commitments get a decision, not forgotten."
        actions={
          <Button
            onClick={async () => {
              const result = await mutate<{ briefing: unknown }>(
                "/api/review/morning",
                undefined,
                "GET",
              );
              if (result) setBriefing(result.briefing);
            }}
          >
            <Sun size={16} />
            Morning briefing
          </Button>
        }
      />
      <div className="review-stats">
        <div>
          <CheckCheck size={21} />
          <strong>{completed.length}</strong>
          <span>Commitments completed</span>
        </div>
        <div>
          <Clock size={21} />
          <strong>{duration(worked)}</strong>
          <span>Actual focused time</span>
        </div>
        <div>
          <CalendarDays size={21} />
          <strong>{duration(planned)}</strong>
          <span>Time planned</span>
        </div>
        <div>
          <ShieldAlert size={21} />
          <strong>{unresolved.length}</strong>
          <span>Need a decision</span>
        </div>
      </div>
      <section className="surface review-unresolved">
        <SectionHeading
          title="Give unfinished work a next step"
          count={unresolved.length}
        />
        {unresolved.length ? (
          unresolved.map((c) => (
            <div className="review-row" key={c.id}>
              <div>
                <strong>{c.title}</strong>
                <p>
                  {duration(c.remaining_minutes)} remaining ·{" "}
                  {dateLabel(c.deadline, tz)}
                </p>
              </div>
              <div className="review-actions">
                <Button
                  onClick={() =>
                    void mutate(`/api/commitments/${c.id}/reschedule`, {
                      deadline: tomorrowDeadline(tz),
                    })
                  }
                >
                  Tomorrow
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void mutate(
                      `/api/commitments/${c.id}`,
                      { status: "cancelled" },
                      "PATCH",
                    )
                  }
                >
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    void mutate(`/api/commitments/${c.id}/complete`)
                  }
                >
                  <Check size={14} />
                  Done
                </Button>
                <CommitmentActions commitment={c} />
              </div>
            </div>
          ))
        ) : (
          <Empty
            title="Everything has a next step."
            description="There are no unresolved commitments due today."
          />
        )}
      </section>
      <section className="surface review-note">
        <SectionHeading
          title="Leave a note for tomorrow"
          description="What worked? What needs a little more room?"
        />
        <textarea
          aria-label="Daily review summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Today I made progress on… Tomorrow, I want to protect time for…"
        />
        <div className="review-save">
          <span className="muted">
            {existing
              ? "A review is saved for today. Saving will update it."
              : "A small reflection goes a long way."}
          </span>
          <Button
            variant="primary"
            onClick={async () => {
              const result = await mutate("/api/review/evening", { summary });
              if (result) toast.success("Daily review saved");
            }}
          >
            <Check size={16} />
            Save daily review
          </Button>
        </div>
      </section>
      {state.reviews.length > 0 && (
        <section className="section-spaced">
          <SectionHeading title="Previous reflections" />
          {state.reviews
            .slice()
            .reverse()
            .slice(0, 7)
            .map((r) => (
              <div className="review-history" key={r.id}>
                <strong>{r.date}</strong>
                <span>
                  {r.completed_count} completed ·{" "}
                  {duration(r.completed_minutes)} worked
                </span>
                <p>{r.summary || "Review saved."}</p>
              </div>
            ))}
        </section>
      )}
      <Modal
        open={!!briefing}
        onOpenChange={(v) => !v && setBriefing(null)}
        title="Your morning briefing"
        description="A deterministic view of your workload and priorities."
        wide
      >
        <BriefingContent value={briefing} />
      </Modal>
    </>
  );
}
function BriefingContent({ value }: { value: unknown }) {
  if (typeof value === "string")
    return <p className="briefing-copy">{value}</p>;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (
      <div className="briefing-copy">
        {Object.entries(object).map(([key, v]) => (
          <div className="briefing-field" key={key}>
            <strong>
              {key.replace(/([A-Z])/g, " $1").replaceAll("_", " ")}
            </strong>
            <p>
              {typeof v === "string" || typeof v === "number"
                ? String(v)
                : Array.isArray(v)
                  ? v
                      .map((item) =>
                        typeof item === "object"
                          ? JSON.stringify(item)
                          : String(item),
                      )
                      .join("\n")
                  : JSON.stringify(v)}
            </p>
          </div>
        ))}
      </div>
    );
  }
  return <p className="muted">Your briefing is ready.</p>;
}
