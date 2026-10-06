import type { RecordKind } from "./types";

const months = "january|february|march|april|may|june|july|august|september|october|november|december";
const ordinal = "(?:\\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[ -](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirtieth|thirty[ -]first)";
const clock = "(?:(?:\\d{1,2}(?::[0-5]\\d)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\\s*(?:a\\.?m\\.?|p\\.?m\\.?))?|noon|midnight)";
const relativeDay = "(?:day after tomorrow|today|tomorrow|tonight|(?:(?:this|next)\\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|week|weekend)|(?:this|next)\\s+(?:morning|afternoon|evening))";
const date = `(?:${ordinal}(?:\\s+of)?\\s+(?:${months})(?:,?\\s+\\d{4})?|(?:${months})\\s+${ordinal}(?:,?\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2}(?:T\\S+)?|${relativeDay})`;
const action = /^(?:do not|don't|never|submit|finish|complete|send|write|draft|create|build|fix|review|read|pay|buy|book|call|email|message|text|remind|follow up|prepare|update|upload|download|export|import|save|open|print|discuss|compare|schedule|reply|check|cancel|renew|pick up|bring|clean|organize|make|ship|publish|record|edit|learn|study|practice|water|feed|take|order|return|collect|apply|get|ask)\b/i;

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function brief(value: string): boolean {
  return value.length <= 60 && value.split(/\s+/).length <= 8;
}

/** Normalize an interpretation copy, never the saved transcript. */
export function conversationalText(value: string): string {
  return value.trim()
    .replace(/[’]/g, "'")
    .replace(/^\s*(?:(?:um|uh|erm|hey|okay|ok|well|so|oh|please|and|then|also|plus)[,.:]?\s+)+/i, "")
    .replace(/^(i|we)\s+(?:also|still)\s+/i, "$1 ")
    .replace(/^(?:can|could|would) you(?: please)? (?:remind me to|remember to|help me to|help me)\s+/i, "Need to ")
    .replace(/^(?:can|could|would) you(?: please)? (send|submit|finish|write|draft|review|call|email|message|pay|book|prepare|upload|download|check)\b/i, "$1")
    .replace(/^(?:remind me to|don't forget to|do not forget to)\s+/i, "Need to ")
    .replace(/^(?:i|we)(?:'ve| have) got to\s+|^(?:i|we) (?:gotta|have gotta|got to)\s+/i, "Need to ")
    .replace(/^(?:i(?:'ve| have) got|i have|there is|there's) (?:a|an) (meeting|appointment|interview|class|lecture)\b/i, "$1")
    .replace(/^(?:i|we) need ((?:a|an|the) (?:update|report|draft|document|reply|response) from\b)/i, "Get $1")
    .replace(/^(?:make a note(?: that)?|note that|just so (?:i|we) remember)\s*[,.:]?\s+/i, "Note: ")
    .replace(/^i was thinking(?: that)?\s+(?=(?:we|i) could|maybe|what if)/i, "Idea: ");
}

function activeTask(value: string): string {
  const passive = /^(?:the |my |our )?(.+?)\s+(?:needs? to be|has to be|must be|should be)\s+(submitted|sent|finished|completed|reviewed|paid|renewed|uploaded|written|prepared)\b/i.exec(value);
  if (!passive) return value;
  const verbs: Record<string, string> = { submitted: "Submit", sent: "Send", finished: "Finish", completed: "Complete", reviewed: "Review", paid: "Pay", renewed: "Renew", uploaded: "Upload", written: "Write", prepared: "Prepare" };
  return `${verbs[passive[2].toLowerCase()]} ${passive[1]}${value.slice(passive[0].length)}`;
}

function stripGrouping(value: string): string {
  return value
    .replace(/^(?:project|collection)\s*:[^\n]+\n/i, "")
    .replace(/^(?:project|collection)\s*:[^\n]+?\s+[-–—]\s+/i, "")
    .replace(/^(?:task|to[ -]?do|note|idea|event|reference|link|resource)\s+for\s+(?:project\s+)?[^:\n]+:\s*/i, "")
    .replace(/^(?:task|to[ -]?do|note|idea|event|reference|link|resource)\s*:\s*/i, "")
    .replace(/^([A-Z][\p{L}\p{N}'’&_-]*(?:\s+[A-Z][\p{L}\p{N}'’&_-]*){0,5}):\s*/u, "");
}

function stripTiming(value: string, kind: RecordKind): string {
  let result = value.replace(
    new RegExp(`\\b(?:by|before|on|due(?:\\s+(?:by|on|at))?|deadline(?:\\s+is|\\s+of|\\s*:)?|until)\\s+(?:the\\s+)?${date}(?:\\s+(?:morning|afternoon|evening))?(?:\\s+(?:at\\s+|around\\s+)?${clock})?`, "gi"),
    "",
  );
  if (kind === "task" || kind === "event") {
    result = result
      .replace(new RegExp(`\\b${date}(?:\\s+(?:morning|afternoon|evening))?(?:\\s+(?:at\\s+|around\\s+)?${clock})?`, "gi"), "")
      .replace(new RegExp(`\\b(?:at|by|before|around|until)\\s+${clock}\\b`, "gi"), "")
      .replace(/\bin\s+(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|hrs?|minutes?|mins?)\b/gi, "")
      .replace(/\b(?:before (?:my |the )?class|soon|sometime|later)\b/gi, "");
  }
  return result;
}

function actionFromNoun(value: string): string {
  if (action.test(value)) return value;
  if (/\bsubmission\b/i.test(value)) {
    const object = value.replace(/\bsubmission(?:\s+of)?\b/i, "").replace(/^\s*(?:of\s+)?(?:the\s+)?/i, "");
    return `Submit ${compact(object)}`;
  }
  if (/^(?:(?:the|a|an)\s+)?(?:payment\b|(?:rent|tax|invoice|bill|tuition)\s+payment\b)/i.test(value))
    return `Pay ${compact(value.replace(/\bpayment(?:\s+(?:of|for))?\b/i, ""))}`;
  if (/^(?:(?:the|a|an)\s+)?(?:renewal\b|(?:visa|passport|license|subscription|membership)\s+renewal\b)/i.test(value))
    return `Renew ${compact(value.replace(/\brenewal(?:\s+of)?\b/i, ""))}`;
  return value;
}

function shorten(value: string): string {
  let words = value.split(/\s+/).filter(Boolean);
  if (words.length > 8) {
    const recipient = /\b(?:to|with|from)\s+[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,2}\b/u.exec(value)?.[0];
    const negative = /\b(?:do not|does not|did not|will not|must not|should not|not|never|cannot|can't|don't|doesn't|without)\b/i.exec(value);
    if (negative && value.slice(0, negative.index).trim().split(/\s+/).length >= 8) {
      words = [...words.slice(0, 3), ...value.slice(negative.index).split(/\s+/).slice(0, 5)];
    } else if (recipient && !words.slice(0, 8).join(" ").includes(recipient)) {
      const nameWords = recipient.split(/\s+/);
      words = [...words.slice(0, 8 - nameWords.length), ...nameWords];
    } else words = words.slice(0, 8);
  }
  while (words.length > 1 && words.join(" ").length > 60) words.pop();
  while (words.length > 1 && /^(?:a|an|the|and|or|but|to|for|with|from|of|that|which)$/i.test(words.at(-1)!)) words.pop();
  return words.join(" ").slice(0, 60).replace(/[\s,;:.!?-]+$/, "");
}

/** Produces a useful heading while leaving the captured source untouched. */
export function briefRecordTitle(title: string, kind: RecordKind, content?: string): string {
  const original = compact(title);
  // A concise heading that differs from the source may be a deliberate user edit.
  if (original && brief(original) && content && compact(stripGrouping(title)) !== compact(stripGrouping(content))) return original;
  let value = stripGrouping(conversationalText(stripGrouping(title || content || "")));
  if (kind === "task") value = activeTask(value);
  value = value
    .replace(/^\s*(?:(?:um|uh|erm|hey|okay|ok|well|so|please)[,.:]?\s+)+/i, "")
    .replace(/^(?:(?:i|we)\s+)?(?:need\s+to|have\s+to|want\s+to|must|should|remember\s+to)\s+/i, "")
    .replace(/^(?:i was thinking(?: that)?|i think(?: that)?|i have an idea(?: that)?|what if (?:we|i)(?: could)?|(?:we|i) could)\s+/i, "")
    .replace(/\s+(?:and|but)\s+(?:then\s+)?(?:i|we)\s+(?:also\s+)?(?:need|want|have)\s+to\b[\s\S]*$/i, "")
    .replace(/\s+(?:it |this |that )?(?:will|would|should)(?: probably)? take\b[\s\S]*$/i, "");
  if (kind === "task") value = value.replace(/\s+(?:maybe|i guess|you know|if possible)[.,?!]*$/i, "");
  value = stripTiming(value, kind);
  if (kind === "reference") {
    const link = /https?:\/\/[^\s]+|www\.[^\s]+/i.exec(value)?.[0];
    if (link) {
      let caption = compact(value.replace(link, "").replace(/^(?:save|bookmark|keep|store)\s*/i, ""));
      if (/^for\s+(?:project\s+)?[\p{L}\p{N}'’& _-]+$/iu.test(caption)) caption = "";
      if (caption) value = caption;
      else {
        try {
          const url = new URL(link.startsWith("www.") ? `https://${link}` : link);
          const path = url.pathname.split("/").filter(Boolean).at(-1);
          const topic = path ? decodeURIComponent(path).replace(/[-_]/g, " ").replace(/\.[a-z0-9]{1,5}$/i, "") : "";
          value = topic ? `${topic[0].toLocaleUpperCase()}${topic.slice(1)} · ${url.hostname.replace(/^www\./, "")}` : url.hostname.replace(/^www\./, "");
        }
        catch { value = link; }
      }
    }
  }
  value = value
    .replace(/\s+(?:and|but)\s+(?:(?:he|she|they|i|we)\s+)?(?:does|do) not (?:want|need|like|prefer)\s+/i, ", not ")
    .replace(/^[\s,;:.!?-]+|[\s,;:.!?-]+$/g, "");
  value = compact(kind === "task" ? actionFromNoun(value) : value);
  // A sentence is a better topic boundary than an arbitrary string cut.
  if (value.length > 60 || value.split(/\s+/).length > 8)
    value = value.split(/(?<=[.!?])\s+|\n/)[0];
  const shortened = shorten(value);
  if (!shortened) return shorten(original) || (kind === "idea" ? "New idea" : "Untitled record");
  if (shortened === original) return original;
  return kind === "reference" ? shortened : shortened[0].toLocaleUpperCase() + shortened.slice(1);
}
