"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Mic, MicOff, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import type { CapturedRecord } from "@/lib/records/types";
import { voiceTranscriptDraft } from "@/lib/records/transcription";
import { useApp } from "./app-provider";
import styles from "./records-view.module.css";

const recordingTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
function requestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === "x" ? value : (value & 3) | 8).toString(16);
  });
}

export function Capture({ compact = false, onSaved, initialText = "" }: {
  compact?: boolean; onSaved?: () => void; initialText?: string;
}) {
  const { mutate } = useApp();
  const captureId = useId();
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [source, setSource] = useState<"text" | "voice">("text");
  const [language, setLanguage] = useState("en");
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryAudio, setRetryAudio] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const recordedAudio = useRef<Blob | null>(null);
  const recordingLanguage = useRef("en");
  const voiceDraft = useRef("");
  const autoSave = useRef(false);
  const retrySaveIntent = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const pending = useRef<{ text: string; source: "text" | "voice"; id: string } | null>(null);

  function releaseMicrophone() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    microphone.current?.getTracks().forEach(track => track.stop());
    microphone.current = null;
  }
  useEffect(() => {
    mounted.current = true;
    setVoiceSupported(!!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
    return () => {
      mounted.current = false;
      autoSave.current = false;
      if (recorder.current) {
        recorder.current.onstop = null;
        recorder.current.ondataavailable = null;
        recorder.current.onerror = null;
        if (recorder.current.state !== "inactive") recorder.current.stop();
      }
      releaseMicrophone();
      recorder.current = null;
      recordedAudio.current = null;
    };
  }, []);
  useEffect(() => { if (initialText) setText(initialText); }, [initialText]);

  async function save(value = text, captureSource = source) {
    const content = value.trim();
    if (!content || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    setSaved(false);
    setFeedback(null);
    let result: { records: CapturedRecord[]; provider: string } | undefined;
    try {
      if (!pending.current || pending.current.text !== content || pending.current.source !== captureSource)
        pending.current = { text: content, source: captureSource, id: requestId() };
      result = await mutate<{ records: CapturedRecord[]; provider: string }>("/api/records", {
        text: content, source: captureSource, request_id: pending.current.id,
      });
    } catch { result = undefined; }
    finally { busyRef.current = false; }
    if (!mounted.current) return false;
    setBusy(false);
    if (!result) {
      setText(value);
      setFailed(true);
      setFeedback("Couldn't save yet. Your transcript is still here — try Save again.");
      return false;
    }
    const collections = [...new Set(result.records.map(record => record.collection))].slice(0, 3);
    const message = `Saved ${result.records.length} record${result.records.length === 1 ? "" : "s"}${collections.length ? ` · ${collections.join(", ")}` : ""}`;
    setText("");
    setSaved(true);
    setSource("text");
    setRetryAudio(false);
    recordedAudio.current = null;
    pending.current = null;
    setFeedback(message);
    toast.success(message);
    onSaved?.();
    return true;
  }

  async function transcribe(audio: Blob, shouldSave: boolean) {
    if (busyRef.current || !mounted.current) return;
    busyRef.current = true;
    retrySaveIntent.current = shouldSave;
    setProcessing(true);
    setRetryAudio(false);
    setFailed(false);
    setFeedback("Transcribing your recording…");
    try {
      const response = await fetch(`/api/transcribe?language=${recordingLanguage.current}`, {
        method: "POST", headers: { "Content-Type": audio.type || "audio/webm" }, body: audio,
      });
      const data = await response.json() as { text?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "Transcription failed. Retry your recording.");
      if (!mounted.current) return;
      if (!data.text?.trim()) {
        recordedAudio.current = null;
        setFeedback("No clear speech was found. Nothing was saved; try recording again.");
        return;
      }
      const draft = voiceTranscriptDraft(voiceDraft.current, data.text);
      setText(draft);
      setSource("voice");
      pending.current = null;
      busyRef.current = false;
      if (shouldSave) await save(draft, "voice");
      else setFeedback("Recording limit reached. Review the transcript, then save.");
    } catch (error) {
      if (!mounted.current) return;
      setFailed(true);
      setRetryAudio(true);
      setFeedback(error instanceof Error ? error.message : "Transcription failed. Retry your recording.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setProcessing(false);
    }
  }

  function stopRecording(shouldSave: boolean) {
    autoSave.current = shouldSave;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (recorder.current?.state !== "inactive") recorder.current?.stop();
  }

  async function voice() {
    if (listening) { stopRecording(true); return; }
    if (busyRef.current || starting || processing) return;
    setStarting(true);
    setSaved(false);
    setFailed(false);
    setFeedback(null);
    try {
      const availability = await fetch("/api/transcribe", { cache: "no-store" });
      const status = await availability.json() as { ready?: boolean; error?: string };
      if (!availability.ok || !status.ready) throw new Error(status.error || "Voice transcription is not ready on the server.");
      if (!mounted.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!mounted.current) { stream.getTracks().forEach(track => track.stop()); return; }
      microphone.current = stream;
      const mimeType = recordingTypes.find(type => MediaRecorder.isTypeSupported(type));
      const instance = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
      const chunks: Blob[] = [];
      let fault = false;
      voiceDraft.current = text.trim();
      recordingLanguage.current = language;
      autoSave.current = false;
      recordedAudio.current = null;
      setRetryAudio(false);
      instance.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      instance.onerror = () => {
        fault = true;
        autoSave.current = false;
        releaseMicrophone();
        if (mounted.current) {
          setListening(false);
          setFeedback("The microphone stopped unexpectedly. Nothing was saved; please record again.");
        }
      };
      instance.onstop = () => {
        releaseMicrophone();
        recorder.current = null;
        if (!mounted.current) return;
        setListening(false);
        if (fault) return;
        const audio = new Blob(chunks, { type: instance.mimeType || mimeType || "audio/webm" });
        if (!audio.size) { setFeedback("The recording was empty. Please try again."); return; }
        recordedAudio.current = audio;
        void transcribe(audio, autoSave.current);
      };
      recorder.current = instance;
      instance.start(1000);
      setListening(true);
      setFeedback("Speak naturally. Stop and save when you're finished.");
      timer.current = setTimeout(() => stopRecording(false), 115000);
    } catch (error) {
      releaseMicrophone();
      if (!mounted.current) return;
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      setFeedback(denied ? "Allow microphone access to record. You can still type here." : error instanceof Error ? error.message : "The microphone couldn't start.");
    } finally { if (mounted.current) setStarting(false); }
  }

  const locked = busy || processing || starting;
  return (
    <div className={styles.capture} data-compact={compact}>
      <form onSubmit={event => { event.preventDefault(); if (!listening && !locked) void save(); }}>
        <label className={styles.captureLabel} htmlFor={captureId}>New record</label>
        <textarea id={captureId} aria-label="Capture anything" rows={2} maxLength={12000}
          value={text} disabled={locked} readOnly={listening}
          onChange={event => {
            setText(event.target.value); pending.current = null;
            if (retryAudio) voiceDraft.current = event.target.value;
            setFeedback(null); setSaved(false);
          }}
          placeholder={listening ? "Recording your voice…" : "Tell me what you need to remember…"}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); if (!listening && !locked) void save();
            }
          }} />
        <div className={styles.captureFooter}>
          <span>{listening ? "Recording…" : processing ? "Transcribing and organizing…" : "Enter saves · Shift + Enter adds a line"}</span>
          <div>
            {retryAudio && <button type="button" className={styles.microphone} disabled={locked}
              onClick={() => { if (recordedAudio.current) void transcribe(recordedAudio.current, retrySaveIntent.current); }}>Retry voice</button>}
            {voiceSupported && <>
              <select className={styles.voiceLanguage} aria-label="Voice language" value={language}
                disabled={listening || locked} onChange={event => setLanguage(event.target.value)}>
                <option value="en">English</option><option value="hi">Hindi</option>
                <option value="auto">Auto</option>
              </select>
              <button type="button" className={styles.microphone}
                aria-label={listening ? "Stop and save recording" : "Capture with voice"}
                aria-pressed={listening} disabled={locked} onClick={() => void voice()}>
                {listening ? <MicOff size={19} /> : <Mic size={19} />}
                <span>{starting ? "Opening…" : listening ? "Stop and save" : "Voice"}</span>
              </button>
            </>}
            <button type="submit" className={styles.saveCapture} aria-label="Save and organize"
              disabled={!text.trim() || locked || listening}>
              {busy || processing ? <><Loader2 size={15} className="spin" />{processing ? "Transcribing…" : "Saving…"}</> : "Save"}
            </button>
          </div>
        </div>
      </form>
      {feedback && <div className={styles.captureHelp} aria-live="polite"><span>{saved && <Check size={12} />}{feedback}</span></div>}
      {failed && <span className={styles.captureFailure} role="alert">Your draft and recording have been kept for retry.</span>}
    </div>
  );
}
