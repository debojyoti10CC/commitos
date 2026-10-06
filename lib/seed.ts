import type { AppState, Commitment, UserSettings } from "./types";
import {
  addLocalDays,
  localDate,
  localTime,
  MINUTE,
  validTimezone,
  zonedDate,
} from "./scheduling/time";

export function defaultSettings(): UserSettings {
  const configuredTimezone =
    typeof process !== "undefined" ? process.env.APP_TIMEZONE : undefined;
  const timezone =
    configuredTimezone && validTimezone(configuredTimezone)
      ? configuredTimezone
      : "Asia/Kolkata";
  return {
    name: "Alex",
    timezone,
    workday_start: "09:00",
    workday_end: "22:00",
    sleep_start: "23:00",
    sleep_end: "07:00",
    meal_blocks: [
      { start: "13:00", end: "14:00", label: "Lunch" },
      { start: "20:00", end: "20:30", label: "Dinner" },
    ],
    max_deep_work_minutes: 360,
    break_minutes: 10,
    focus_block_minutes: 50,
    default_task_minutes: 45,
    telegram_enabled: false,
    briefing_time: "08:30",
    review_time: "21:30",
    risk_alerts: true,
    check_in_alerts: true,
    calendar_id: "primary",
    calendar_write_enabled: false,
    gmail_mining_enabled: false,
    gmail_scan_minutes: 60,
    theme: "light",
  };
}

export function createSeedState(userId: string, now = new Date()): AppState {
  const settings = defaultSettings();
  const day = localDate(now, settings.timezone);
  const tomorrow = addLocalDays(day, 1);
  const currentHour = Number(localTime(now, settings.timezone).slice(0, 2));
  const deliveryDay = currentHour >= 21 ? tomorrow : day;
  const stamp = now.toISOString();
  const id = (suffix: number) =>
    `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
  const at = (date: string, clock: string) =>
    zonedDate(date, clock, settings.timezone).toISOString();
  let friday = day;
  do {
    friday = addLocalDays(friday, 1);
  } while (new Date(`${friday}T12:00:00Z`).getUTCDay() !== 5);
  const make = (
    suffix: number,
    title: string,
    minutes: number,
    deadline: string | null,
    extra: Partial<Commitment> = {},
  ): Commitment => ({
    id: id(suffix),
    user_id: userId,
    title,
    description: "",
    project: null,
    commitment_type: "deliverable",
    contact_name: null,
    organization: null,
    source: "manual",
    source_reference: null,
    source_url: null,
    status: "inbox",
    priority: "medium",
    created_at: new Date(now.getTime() - 24 * 60 * MINUTE).toISOString(),
    updated_at: stamp,
    deadline,
    check_in_at: null,
    scheduled_start: null,
    scheduled_end: null,
    estimated_minutes: minutes,
    completed_minutes: 0,
    remaining_minutes: minutes,
    next_action: title,
    risk_score: 0,
    risk_level: "safe",
    last_risk_calculation_at: null,
    last_reminded_at: null,
    reminder_count: 0,
    snoozed_until: null,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    metadata: { demo: true },
    ...extra,
  });
  const commitments = [
    make(1, "Finish HydraDB launch video", 120, at(deliveryDay, "21:00"), {
      project: "HydraDB",
      commitment_type: "content",
      organization: "HydraDB",
      contact_name: "Rohan",
      priority: "high",
      status: "scheduled",
      check_in_at: at(deliveryDay, "18:00"),
      next_action: "Cut the final demo sequence and export the launch video.",
      estimated_minutes: 150,
      completed_minutes: 30,
      description:
        "Deliver the 90-second launch video and send Rohan a progress update before export.",
    }),
    make(2, "Submit IIT assignment", 180, at(tomorrow, "23:59"), {
      project: "IIT Patna",
      commitment_type: "academic",
      priority: "high",
      next_action: "Finish problems 4–6, then upload the signed PDF.",
    }),
    make(3, "Ship hackathon submission", 1560, at(friday, "23:59"), {
      project: "Soleil",
      priority: "critical",
      description:
        "Polish the demo, record the walkthrough, and submit the project before judging closes.",
      next_action: "Connect the end-to-end checkout flow in the demo.",
    }),
    make(4, "Reply to partnership sponsor", 10, at(deliveryDay, "19:30"), {
      project: "Soleil",
      commitment_type: "communication",
      contact_name: "Ayush",
      organization: "Devfolio",
      priority: "high",
      next_action: "Send the updated deck and confirm demo availability.",
    }),
    make(5, "Publish BitcoinHer community post", 30, at(deliveryDay, "22:00"), {
      project: "BitcoinHer",
      commitment_type: "content",
      next_action: "Review the caption, add the event link, and publish.",
    }),
    make(
      6,
      "Submit travel reimbursement form",
      15,
      at(addLocalDays(day, 2), "17:00"),
      {
        commitment_type: "administrative",
        next_action: "Attach receipts and bank details to the event form.",
      },
    ),
    make(
      7,
      "Confirm design feedback with Kimia",
      15,
      at(addLocalDays(day, 3), "18:00"),
      {
        project: "Kimia",
        commitment_type: "follow_up",
        contact_name: "Maya",
        status: "waiting",
        check_in_at: at(tomorrow, "11:00"),
        next_action: "Ask Maya whether the visual direction is approved.",
      },
    ),
    make(8, "Review sponsor agreement", 45, at(addLocalDays(day, 2), "18:00"), {
      project: "Soleil",
      status: "blocked",
      next_action: "Get the updated agreement from the sponsor.",
      metadata: { demo: true, depends_on: [id(4)] },
    }),
    make(9, "Send meeting notes to the team", 20, at(day, "12:00"), {
      commitment_type: "communication",
      status: "done",
      remaining_minutes: 0,
      completed_minutes: 20,
      completed_at: new Date(now.getTime() - 60 * MINUTE).toISOString(),
      started_at: new Date(now.getTime() - 80 * MINUTE).toISOString(),
    }),
  ];
  const candidateParsed = {
    title: "Complete community speaker form",
    description: "Please complete the speaker form by tomorrow at 5 PM.",
    project: null,
    commitmentType: "administrative" as const,
    contactName: "Priya",
    organization: "Builder Circle",
    deadline: at(tomorrow, "17:00"),
    checkInAt: null,
    estimatedMinutes: 15,
    priority: "medium" as const,
    nextAction: "Open the form and add your bio and talk title.",
    confidence: 0.88,
    inferredFields: ["estimatedMinutes"],
    warnings: ["Effort inferred as 15 minutes."],
  };
  return {
    version: 1,
    records: [],
    user_id: userId,
    commitments,
    projects: [
      {
        id: id(101),
        user_id: userId,
        name: "HydraDB",
        description: "Launch assets and developer content.",
        color: "#d0e283",
        archived: false,
        created_at: stamp,
      },
      {
        id: id(102),
        user_id: userId,
        name: "Soleil",
        description: "Hackathon product, demo and partnerships.",
        color: "#93b8ee",
        archived: false,
        created_at: stamp,
      },
      {
        id: id(103),
        user_id: userId,
        name: "IIT Patna",
        description: "Academic deadlines and coursework.",
        color: "#c7a5e8",
        archived: false,
        created_at: stamp,
      },
      {
        id: id(104),
        user_id: userId,
        name: "BitcoinHer",
        description: "Community events and content.",
        color: "#e6ba86",
        archived: false,
        created_at: stamp,
      },
      {
        id: id(105),
        user_id: userId,
        name: "Kimia",
        description: "Brand work and design collaboration.",
        color: "#86cbb8",
        archived: false,
        created_at: stamp,
      },
    ],
    contacts: [
      {
        id: id(201),
        user_id: userId,
        name: "Rohan",
        organization: "HydraDB",
        email: "rohan@example.com",
        telegram: "",
        notes: "Send progress updates before delivering launch assets.",
      },
      {
        id: id(202),
        user_id: userId,
        name: "Ayush",
        organization: "Devfolio",
        email: "ayush@example.com",
        telegram: "",
        notes: "Partnership sponsor and demo contact.",
      },
      {
        id: id(203),
        user_id: userId,
        name: "Maya",
        organization: "Kimia",
        email: "maya@example.com",
        telegram: "",
        notes: "Approves visual direction.",
      },
    ],
    sessions: [
      {
        id: id(301),
        user_id: userId,
        commitment_id: id(9),
        started_at: new Date(now.getTime() - 80 * MINUTE).toISOString(),
        ended_at: new Date(now.getTime() - 60 * MINUTE).toISOString(),
        duration_minutes: 20,
        notes: "Shared team notes.",
      },
    ],
    reminders: [],
    integrations: [
      {
        id: id(401),
        user_id: userId,
        provider: "telegram",
        connected: false,
        metadata: {},
      },
      {
        id: id(402),
        user_id: userId,
        provider: "google",
        connected: false,
        metadata: {},
      },
    ],
    reviews: [],
    activity: [
      {
        id: id(501),
        user_id: userId,
        commitment_id: id(9),
        type: "commitment_completed",
        message: "Sent meeting notes to the team",
        created_at: commitments[8].completed_at!,
      },
    ],
    calendar_events: [
      {
        id: id(601),
        user_id: userId,
        title: "Product team standup",
        start: at(day, "10:00"),
        end: at(day, "10:30"),
        source: "local",
        commitment_id: null,
        external_id: null,
      },
      {
        id: id(602),
        user_id: userId,
        title: "IIT live class",
        start: at(day, "16:00"),
        end: at(day, "17:00"),
        source: "local",
        commitment_id: null,
        external_id: null,
      },
      {
        id: id(603),
        user_id: userId,
        title: "Project sync with Ayush",
        start: at(tomorrow, "11:00"),
        end: at(tomorrow, "11:45"),
        source: "local",
        commitment_id: null,
        external_id: null,
      },
    ],
    candidates: [
      {
        id: id(701),
        user_id: userId,
        email_id: "demo-speaker-invite",
        subject: "Speaker details needed for Builder Circle",
        sender: "Priya <priya@example.com>",
        body: "Please complete the speaker form by tomorrow at 5 PM. Add your bio and talk title.",
        parsed: candidateParsed,
        status: "pending",
        created_at: stamp,
      },
    ],
    settings,
  };
}
