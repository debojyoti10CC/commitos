import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export const MINUTE = 60_000;
export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
export function localDate(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "yyyy-MM-dd");
}
export function localTime(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "HH:mm");
}
export function addLocalDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function zonedDate(day: string, clock: string, timezone: string): Date {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(clock)
  )
    throw new Error("Invalid local date or time");
  return fromZonedTime(
    `${day}T${clock.length === 5 ? `${clock}:00` : clock}`,
    timezone,
  );
}
export function dayBounds(day: string, timezone: string): [Date, Date] {
  return [
    zonedDate(day, "00:00", timezone),
    zonedDate(addLocalDays(day, 1), "00:00", timezone),
  ];
}
export function minutesBetween(
  start: string | Date,
  end: string | Date,
): number {
  return Math.max(
    0,
    (new Date(end).getTime() - new Date(start).getTime()) / MINUTE,
  );
}
export function isValidInstant(
  value: string | null | undefined,
): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}
export function formatMinutes(value: number): string {
  const minutes = Math.max(0, Math.round(value));
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
    : `${minutes}m`;
}
