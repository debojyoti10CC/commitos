export interface BrowserSpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}

export type VoiceLanguage = "en-IN" | "en-US" | "hi-IN";

export function defaultVoiceLanguage(browserLanguage: string): VoiceLanguage {
  if (browserLanguage.toLowerCase().startsWith("hi")) return "hi-IN";
  if (browserLanguage.toLowerCase() === "en-us") return "en-US";
  return "en-IN";
}

/** Each browser result event is a full snapshot, including previous final results. */
export function readSpeechTranscript(results: ArrayLike<BrowserSpeechResult>) {
  const final: string[] = [],
    interim: string[] = [],
    transcript: string[] = [];
  for (let index = 0; index < results.length; index++) {
    const words = results[index][0].transcript.trim();
    if (!words) continue;
    transcript.push(words);
    (results[index].isFinal ? final : interim).push(words);
  }
  return {
    final: final.join(" "),
    interim: interim.join(" "),
    transcript: transcript.join(" "),
  };
}

export function voiceTranscriptDraft(
  existingDraft: string,
  transcript: string,
) {
  return [existingDraft.trim(), transcript.trim()].filter(Boolean).join("\n");
}
