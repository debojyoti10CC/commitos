import type { ParsedCommitment } from "../types";
import {
  addLocalDays,
  localDate,
  localTime,
  MINUTE,
  validTimezone,
  zonedDate,
} from "../scheduling/time";
import { ParsedCommitmentSchema } from "./schema";

export interface ParseContext {
  now?: Date;
  timezone: string;
  projects?: string[];
  defaultMinutes?: number;
}
export interface NormalizedDate {
  date: string | null;
  inferred: boolean;
  warnings: string[];
}
const words: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fortyfive: 45,
  sixty: 60,
};
const numberPattern =
  "(?:\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|sixty)";
const ordinalDays: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11,
  twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, "twenty-first": 21, "twenty-second": 22,
  "twenty-third": 23, "twenty-fourth": 24, "twenty-fifth": 25,
  "twenty-sixth": 26, "twenty-seventh": 27, "twenty-eighth": 28,
  "twenty-ninth": 29, thirtieth: 30, "thirty-first": 31,
};
const calendarDayPattern = `(?:\\d{1,2}(?:st|nd|rd|th)?|${Object.keys(ordinalDays)
  .sort((a, b) => b.length - a.length)
  .join("|")
  .replaceAll("-", "[ -]")})`;
const monthPattern = "january|february|march|april|may|june|july|august|september|october|november|december";
function numeric(value: string): number {
  return words[value.toLowerCase()] ?? Number(value);
}

/** Wall-clock expressions are resolved in the user's timezone, never the host timezone. */
export function normalizeNaturalDate(
  text: string,
  context: ParseContext,
): NormalizedDate {
  const now = context.now ?? new Date();
  const timezone = validTimezone(context.timezone)
    ? context.timezone
    : "Asia/Kolkata";
  const lower = text.toLowerCase();
  const warnings: string[] = [];
  if (!validTimezone(context.timezone))
    warnings.push("Invalid timezone; using Asia/Kolkata.");
  if (/\bbefore (?:my |the )?class\b/.test(lower))
    return {
      date: null,
      inferred: false,
      warnings: [
        ...warnings,
        "Class time is unknown. Add an exact deadline or calendar event.",
      ],
    };
  const relative = new RegExp(
    `\\bin\\s+(${numberPattern})\\s*(hours?|hrs?|h|minutes?|mins?|m)\\b`,
    "i",
  ).exec(lower);
  if (relative)
    return {
      date: new Date(
        now.getTime() +
          numeric(relative[1]) * (/^h/.test(relative[2]) ? 60 : 1) * MINUTE,
      ).toISOString(),
      inferred: false,
      warnings,
    };
  let day = localDate(now, timezone);
  let clockText = lower;
  let specifiedDay = false;
  let inferred = false;
  if (/\bday after tomorrow\b/.test(lower)) {
    day = addLocalDays(day, 2);
    specifiedDay = true;
  } else if (/\btomorrow\b/.test(lower)) {
    day = addLocalDays(day, 1);
    specifiedDay = true;
  } else if (/\b(today|tonight)\b/.test(lower)) specifiedDay = true;
  else {
    const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(lower);
    const weekdays = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    const weekday =
      /\b(?:(next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(
        lower,
      );
    const months = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const dayFirst = new RegExp(
      `\\b(${calendarDayPattern})(?:\\s+of)?\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?\\b`,
    ).exec(lower);
    const monthFirst = new RegExp(
      `\\b(${monthPattern})\\s+(${calendarDayPattern})\\b(?!\\s*(?:a\\.?m\\.?|p\\.?m\\.?)\\b|:[0-5]\\d)(?:,?\\s+(\\d{4}))?\\b`,
    ).exec(lower);
    const useDayFirst = dayFirst && (!monthFirst || dayFirst.index < monthFirst.index);
    const namedDate = useDayFirst ? dayFirst : monthFirst;
    if (iso) {
      day = iso[1];
      specifiedDay = true;
    } else if (weekday) {
      const currentWeekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      let distance = (weekdays.indexOf(weekday[2]) - currentWeekday + 7) % 7;
      if (distance === 0 && weekday[1] !== "this") distance = 7;
      day = addLocalDays(day, distance);
      specifiedDay = true;
      if (weekday[1] === "next") {
        inferred = true;
        warnings.push(
          "“Next” weekday means the next occurrence; confirm the date.",
        );
      }
    } else if (namedDate) {
      const year = namedDate[3] ?? day.slice(0, 4);
      const month = namedDate[useDayFirst ? 2 : 1];
      const dayToken = namedDate[useDayFirst ? 1 : 2];
      const dateNumber = ordinalDays[dayToken.replace(/ /g, "-")] ?? Number(dayToken.replace(/(?:st|nd|rd|th)$/, ""));
      day = `${year}-${String(months.indexOf(month) + 1).padStart(2, "0")}-${String(dateNumber).padStart(2, "0")}`;
      // Date numbers must not also compete with the separate clock expression.
      clockText = `${lower.slice(0, namedDate.index)}${" ".repeat(namedDate[0].length)}${lower.slice(namedDate.index + namedDate[0].length)}`;
      if (!namedDate[3] && day < localDate(now, timezone))
        day = `${Number(year) + 1}${day.slice(4)}`;
      specifiedDay = true;
      if (!namedDate[3]) inferred = true;
    } else if (new RegExp(`(?:\\b(?:by|before|on|in)\\s+|^)(${monthPattern})\\b`).test(lower)) {
      return {
        date: null,
        inferred: false,
        warnings: [...warnings, "A month was given without a calendar day. The clock time was not used as the date."],
      };
    }
  }
  let clock: string | null = null;
  const clockMatch =
    /\b(?:by|before|at|around|about|until)\s+(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i.exec(
      clockText,
    ) ??
    /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(clockText) ??
    /\b(\d{1,2}):([0-5]\d)\b/.exec(clockText);
  const wordClock = new RegExp(
    `\\b(?:by|before|at|around|about|until)\\s+(${numberPattern})\\s*(a\\.?m\\.?|p\\.?m\\.?)?\\b`,
    "i",
  ).exec(clockText) ?? new RegExp(`\\b(${numberPattern})\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b`, "i").exec(clockText);
  if (clockMatch || wordClock) {
    const match = clockMatch ?? wordClock!;
    let hour = numeric(match[1]);
    const minute = Number(clockMatch?.[2] ?? 0);
    const period = (clockMatch?.[3] ?? wordClock?.[2])?.replaceAll(".", "");
    if (hour > 23 || minute > 59 || (period && (hour < 1 || hour > 12)))
      return {
        date: null,
        inferred: false,
        warnings: [
          ...warnings,
          "Time is invalid. Enter a time such as 21:00 or 9 PM.",
        ],
      };
    if (period === "am") hour %= 12;
    else if (period === "pm") hour = (hour % 12) + 12;
    else if (hour >= 1 && hour <= 12 && !clockMatch?.[2]) {
      if (
        /\b(tonight|evening|afternoon)\b/.test(lower) ||
        (!/\bmorning\b/.test(lower) &&
          Number(localTime(now, timezone).slice(0, 2)) >= 12)
      )
        hour = (hour % 12) + 12;
      inferred = true;
      warnings.push(
        `AM/PM was inferred as ${hour >= 12 ? "PM" : "AM"}; confirm the time.`,
      );
    }
    clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (/\b(around|about)\b/.test(lower)) inferred = true;
  } else if (/\bmidnight\b/.test(lower)) {
    clock = "23:59";
    inferred = true;
    warnings.push("Midnight is represented as 23:59 on the stated date.");
  } else if (/\bnoon\b/.test(lower)) clock = "12:00";
  else if (/\bmorning\b/.test(lower)) {
    clock = "09:00";
    inferred = true;
    warnings.push("Morning was inferred as 9 AM.");
  } else if (/\bafternoon\b/.test(lower)) {
    clock = "15:00";
    inferred = true;
    warnings.push("Afternoon was inferred as 3 PM.");
  } else if (/\bevening\b/.test(lower)) {
    clock = "18:00";
    inferred = true;
    warnings.push("Evening was inferred as 6 PM.");
  } else if (/\btonight\b/.test(lower)) {
    clock = "21:00";
    inferred = true;
    warnings.push("Tonight was inferred as 9 PM.");
  } else if (specifiedDay) {
    clock = "23:59";
    inferred = true;
    warnings.push("No exact time given; deadline inferred as 11:59 PM.");
  }
  if (!clock) return { date: null, inferred: false, warnings };
  try {
    let date = zonedDate(day, clock, timezone);
    if (!specifiedDay && date <= now) {
      day = addLocalDays(day, 1);
      date = zonedDate(day, clock, timezone);
      inferred = true;
      warnings.push("Time-only deadline was moved to its next occurrence.");
    }
    if (
      localDate(date, timezone) !== day ||
      localTime(date, timezone) !== clock
    )
      return {
        date: null,
        inferred: false,
        warnings: [
          ...warnings,
          "This local time is invalid because of a clock change or invalid date. Choose another time.",
        ],
      };
    return { date: date.toISOString(), inferred, warnings };
  } catch {
    return {
      date: null,
      inferred: false,
      warnings: [
        ...warnings,
        "The stated date is invalid. Confirm the deadline.",
      ],
    };
  }
}

export function deterministicParse(
  text: string,
  context: ParseContext,
): ParsedCommitment {
  const source = text.trim().replace(/^\/task\s+/i, "");
  if (!source || source.length > 8000)
    throw new Error("Enter a commitment between 1 and 8000 characters.");
  const warnings: string[] = [];
  if (!validTimezone(context.timezone)) {
    context = { ...context, timezone: "Asia/Kolkata" };
    warnings.push("Invalid timezone; using Asia/Kolkata.");
  }
  const inferredFields: string[] = [];
  // Separate progress-update promises from the actual delivery deadline.
  const clauses = source.split(
    /(?<=[.!?])\s+|\s+(?:and|but)\s+(?=(?:I\s+)?(?:send|give|update|check[ -]?in|need to send|promised))/i,
  );
  const checkClause =
    clauses.length > 1
      ? clauses.find(
          (clause) =>
            /\b(update|check[ -]?in|progress report)\b/i.test(clause) &&
            /\b(send|promis|give|check|update)\w*\b/i.test(clause),
        )
      : undefined;
  const primary =
    clauses.find((clause) => clause !== checkClause) ?? clauses[0];
  let deadlineText = primary;
  if (checkClause)
    deadlineText =
      clauses
        .filter(
          (clause) =>
            clause !== checkClause &&
            !/\b(take|roughly|probably|hours?|minutes?)\b/i.test(clause),
        )
        .join(" ") || primary;
  const deadline = normalizeNaturalDate(deadlineText, context);
  // A progress update around six before a tonight delivery inherits the evening context,
  // even if capture happens in the morning.
  const inheritedPeriod =
    deadline.date &&
    !/\b(?:a\.?m\.?|p\.?m\.?|morning|afternoon|evening|tonight)\b/i.test(
      checkClause ?? "",
    ) &&
    Number(localTime(new Date(deadline.date), context.timezone).slice(0, 2)) >=
      12
      ? " evening"
      : "";
  const checkIn = checkClause
    ? normalizeNaturalDate(`${checkClause}${inheritedPeriod}`, context)
    : { date: null, inferred: false, warnings: [] };
  // A date-less check-in shares the delivery date rather than silently moving to tomorrow.
  if (
    checkIn.date &&
    deadline.date &&
    checkClause &&
    !/\b(today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d{4}-\d{2}-\d{2})\b/i.test(
      checkClause,
    )
  ) {
    const date = new Date(checkIn.date);
    checkIn.date = zonedDate(
      localDate(new Date(deadline.date), context.timezone),
      localTime(date, context.timezone),
      context.timezone,
    ).toISOString();
    checkIn.inferred = true;
  }
  warnings.push(
    ...deadline.warnings,
    ...checkIn.warnings.map((warning) => `Check-in: ${warning}`),
  );
  if (deadline.inferred) inferredFields.push("deadline");
  if (checkIn.inferred) inferredFields.push("checkInAt");
  if (checkClause && !checkIn.date)
    warnings.push(
      "Progress update detected, but no check-in time was resolved.",
    );
  if (
    checkIn.date &&
    deadline.date &&
    Date.parse(checkIn.date) > Date.parse(deadline.date)
  )
    warnings.push(
      "Check-in is after the delivery deadline. Confirm both times.",
    );
  let estimatedMinutes: number | null = null;
  const durationText = source.replace(
    new RegExp(
      `\\bin\\s+${numberPattern}\\s*(?:hours?|hrs?|h|minutes?|mins?|m)\\b`,
      "ig",
    ),
    "",
  );
  const durations = [
    ...durationText.matchAll(
      new RegExp(
        `(${numberPattern})\\s*(hours?|hrs?|h|minutes?|mins?|m)(?=\\b|\\d)`,
        "ig",
      ),
    ),
  ];
  if (durations.length)
    estimatedMinutes = Math.round(
      durations.reduce(
        (total, match) =>
          total + numeric(match[1]) * (/^h/i.test(match[2]) ? 60 : 1),
        0,
      ),
    );
  if (/\bhalf (?:an? )?hour\b/i.test(source))
    estimatedMinutes = (estimatedMinutes ?? 0) + 30;
  if (
    estimatedMinutes !== null &&
    (estimatedMinutes < 1 || estimatedMinutes > 525600)
  ) {
    estimatedMinutes = null;
    warnings.push(
      "Effort is outside the supported range. Confirm your estimate.",
    );
  }
  if (estimatedMinutes === null) {
    estimatedMinutes = Math.max(
      1,
      Math.min(525600, Math.round(context.defaultMinutes ?? 45)),
    );
    inferredFields.push("estimatedMinutes");
    warnings.push(`Effort inferred as ${estimatedMinutes} minutes.`);
  }
  let title = primary
    .replace(
      /^(?:I\s+)?(?:need to|have to|must|should|want to|will|promised to)\s+/i,
      "",
    )
    .replace(
      /\s*[,;]?\s*(?:today|tonight|tomorrow|next\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|by\s+|before\s+|due\s+|in\s+\d+\s*(?:hours?|minutes?)|probably\s+|roughly\s+).*/i,
      "",
    )
    .replace(
      new RegExp(
        `\\s*[,;]?\\s*${numberPattern}\\s*(?:hours?|hrs?|h|minutes?|mins?|m)\\b.*`,
        "i",
      ),
      "",
    )
    .replace(/[.!?]+$/, "")
    .trim();
  if (!title) title = primary.trim();
  title = `${title[0]?.toUpperCase() ?? ""}${title.slice(1)}`.slice(0, 200);
  const lower = source.toLowerCase();
  const knownProject = context.projects?.find(
    (project) =>
      project.trim() &&
      new RegExp(
        `\\b${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "i",
      ).test(source),
  );
  const inferredProject =
    /\b(?:finish|build|publish|submit|complete|send)\s+([A-Z][A-Za-z0-9]+(?:DB|OS|Her)?)(?=\s+(?:demo|video|launch|post|deck|project|submission|graphic))/i.exec(
      primary,
    )?.[1];
  const project =
    knownProject ??
    (inferredProject && /^[A-Z]/.test(inferredProject)
      ? inferredProject
      : null);
  if (project && !knownProject) inferredFields.push("project");
  const contactName =
    /\b(?:send|give|email|tell)\s+([A-Z][a-z]+)\s+(?:an?\s+)?(?:update|email|message|report)\b/.exec(
      source,
    )?.[1] ??
    /\b(?:reply|respond)\s+to\s+([A-Z][a-z]+)\b/.exec(source)?.[1] ??
    null;
  const commitmentType: ParsedCommitment["commitmentType"] =
    /\b(assignment|exam|class|study|thesis)\b/.test(lower)
      ? "academic"
      : /\b(video|post|content|graphic)\b/.test(lower)
        ? "content"
        : /\b(form|application|register|registration|invoice)\b/.test(lower)
          ? "administrative"
          : /\b(follow[ -]?up|chase)\b/.test(lower)
            ? "follow_up"
            : /\b(meet|meeting|call)\b/.test(lower)
              ? "meeting"
              : /\b(reply|email|message|update|send)\b/.test(lower)
                ? "communication"
                : /\b(demo|submit|submission|deliver|finish|build)\b/.test(
                      lower,
                    )
                  ? "deliverable"
                  : "other";
  const priority: ParsedCommitment["priority"] =
    /\b(critical|asap|urgent|immediately)\b/.test(lower)
      ? "critical"
      : /\b(important|promised|deadline|today|tonight)\b/.test(lower)
        ? "high"
        : /\b(eventually|sometime|low priority)\b/.test(lower)
          ? "low"
          : "medium";
  inferredFields.push("priority", "commitmentType", "nextAction");
  if (!deadline.date)
    warnings.push(
      "No deadline resolved. You can capture this in Inbox and add a date later.",
    );
  return ParsedCommitmentSchema.parse({
    title,
    description: source,
    project,
    commitmentType,
    contactName,
    organization: project,
    deadline: deadline.date,
    checkInAt: checkIn.date,
    estimatedMinutes,
    priority,
    nextAction: title,
    confidence: Math.max(
      0.35,
      Math.min(
        0.94,
        0.94 - warnings.length * 0.07 - (!deadline.date ? 0.13 : 0),
      ),
    ),
    inferredFields: [...new Set(inferredFields)],
    warnings: [...new Set(warnings)],
  });
}
