import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
export function duration(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes));
  return rounded >= 60
    ? `${Math.floor(rounded / 60)}h${rounded % 60 ? ` ${rounded % 60}m` : ""}`
    : `${rounded}m`;
}
export function clockTime(value: string | null, tz = "Asia/Kolkata") {
  return value ? formatInTimeZone(value, tz, "h:mm a") : "No deadline";
}
export function localDay(tz: string, date = new Date()) {
  return formatInTimeZone(date, tz, "yyyy-MM-dd");
}
export function dateLabel(value: string | null, tz: string) {
  if (!value) return "No deadline";
  const day = localDay(tz, new Date(value)),
    today = localDay(tz);
  return `${day === today ? "Today" : formatInTimeZone(value, tz, "MMM d")} · ${clockTime(value, tz)}`;
}
export function inputDate(value: string | null, tz: string) {
  return value ? formatInTimeZone(value, tz, "yyyy-MM-dd'T'HH:mm") : "";
}
export function fromInput(value: string, tz: string) {
  return value ? fromZonedTime(value, tz).toISOString() : null;
}
export function deadlinePatchFromInput(
  value: string,
  initialValue: string,
  tz: string,
): { deadline?: string | null } {
  // The input displays minutes, so an unchanged value cannot round-trip the
  // source's seconds or distinguish repeated local times during a clock change.
  return value === initialValue
    ? {}
    : { deadline: fromInput(value, tz) };
}
export function tomorrowDeadline(tz: string) {
  const day = localDay(tz, new Date(Date.now() + 86400000));
  return fromZonedTime(`${day}T18:00:00`, tz).toISOString();
}
