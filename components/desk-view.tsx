"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Expand,
  Loader2,
  Minimize,
  Moon,
  Pause,
  Play,
  Plus,
  Power,
  Sun,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { PRODUCT } from "@/lib/config";
import { buildDeskSnapshot } from "@/lib/device/snapshot";
import {
  emptyDeskGesture,
  nextDeskGestureDeadline,
  reduceDeskGesture,
  type DeskGestureAction,
  type DeskGestureEvent,
} from "@/lib/device/gesture";
import { useApp } from "./app-provider";
import { Button, Modal } from "./ui";
import { Capture } from "./capture";
import { dateLabel, duration } from "./format";
import styles from "@/app/desk/desk.module.css";

function timerLabel(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 3600)).padStart(2, "0")}:${String(Math.floor(safe / 60) % 60).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function DeskView() {
  const {
    state,
    loading,
    error,
    mode,
    refresh,
    mutate,
    captureOpen,
    setCaptureOpen,
    commandOpen,
    setCommandOpen,
  } = useApp();
  const [clock, setClock] = useState(Date.now()),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(true),
    [stale, setStale] = useState(false),
    [nextOpen, setNextOpen] = useState(false),
    [browseIndex, setBrowseIndex] = useState(0),
    [fullscreen, setFullscreen] = useState(false),
    [awakeEnabled, setAwakeEnabled] = useState(false),
    [awake, setAwake] = useState(false),
    [awakeSupported, setAwakeSupported] = useState(false),
    [fullscreenSupported, setFullscreenSupported] = useState(false);
  const busyRef = useRef(false),
    stateRef = useRef(state),
    disabledRef = useRef(true),
    captureRef = useRef(captureOpen || commandOpen),
    previousState = useRef(state),
    gestureState = useRef(emptyDeskGesture()),
    gestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    lastInput = useRef<"pointer" | "keyboard" | null>(null),
    wakeLock = useRef<WakeLockSentinel | null>(null),
    wakeWanted = useRef(false);
  const snapshot = useMemo(
    () => (state ? buildDeskSnapshot(state, new Date(clock)) : null),
    [state, clock],
  );
  const current = snapshot?.now ?? null,
    next = snapshot?.next ?? [],
    browsed = next[Math.min(browseIndex, Math.max(0, next.length - 1))];
  const disconnected = !online || stale || Boolean(error),
    disabled = busy || disconnected || !state;
  stateRef.current = state;
  disabledRef.current = disabled;
  captureRef.current = captureOpen || commandOpen;

  useEffect(() => {
    if (error) setStale(true);
    if (state && state !== previousState.current) {
      previousState.current = state;
      setStale(false);
    }
  }, [state, error]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    const sync = () => {
      setOnline(navigator.onLine);
      if (document.visibilityState === "visible" && !busyRef.current)
        void refresh();
    };
    const polling = setInterval(sync, 15000);
    setOnline(navigator.onLine);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("online", sync);
    const offline = () => setOnline(false);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", sync);
    return () => {
      clearInterval(timer);
      clearInterval(polling);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", sync);
    };
  }, [refresh]);

  function openCapture() {
    setCommandOpen(false);
    setCaptureOpen(true);
  }
  async function action(id: string, name: "start" | "pause" | "complete") {
    if (busyRef.current || disabledRef.current) return;
    const original = stateRef.current?.commitments.find(
      (task) => task.id === id,
    );
    if (!original || ["done", "cancelled"].includes(original.status)) return;
    busyRef.current = true;
    setBusy(true);
    const result = await mutate(`/api/commitments/${id}/${name}`);
    busyRef.current = false;
    setBusy(false);
    if (result)
      toast.success(
        name === "complete"
          ? "Commitment completed"
          : name === "pause"
            ? "Focus paused"
            : "Focus started",
        { description: original.title },
      );
    else setStale(true);
  }
  const performRef = useRef<(action: DeskGestureAction) => void>(() => {});
  performRef.current = (result) => {
    if (result.type === "capture") openCapture();
    else void action(result.id, result.type);
  };
  function gesture(event: DeskGestureEvent) {
    if (gestureTimer.current) {
      clearTimeout(gestureTimer.current);
      gestureTimer.current = null;
    }
    const result = reduceDeskGesture(gestureState.current, event);
    gestureState.current = result.state;
    for (const intent of result.actions) performRef.current(intent);
    const deadline = nextDeskGestureDeadline(result.state);
    if (deadline !== null)
      gestureTimer.current = setTimeout(
        () => gesture({ type: "advance", at: Date.now() }),
        Math.max(0, deadline - Date.now()),
      );
  }
  const gestureRef = useRef(gesture);
  gestureRef.current = gesture;
  useEffect(() => {
    if (captureOpen || commandOpen || disabled) {
      gestureRef.current({ type: "cancel" });
      lastInput.current = null;
    }
  }, [captureOpen, commandOpen, disabled]);
  useEffect(() => {
    gestureRef.current({ type: "cancel" });
    lastInput.current = null;
  }, [current?.id]);
  useEffect(() => {
    const editing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      Boolean(
        target.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog]",
        ) ||
        (Boolean(target.closest("button, a, [role=button]")) &&
          !target.closest("[data-desk-button]")),
      );
    const down = (event: KeyboardEvent) => {
      if (editing(event.target) || captureRef.current || disabledRef.current)
        return;
      if (event.code === "Space") {
        event.preventDefault();
        if (event.repeat || lastInput.current === "pointer") return;
        lastInput.current = "keyboard";
        gestureRef.current({
          type: "press",
          id: buildDeskSnapshot(stateRef.current!, new Date()).now?.id ?? null,
          at: Date.now(),
        });
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setNextOpen(true);
        setBrowseIndex((index) => {
          const count = Math.max(
            1,
            buildDeskSnapshot(stateRef.current!, new Date()).next.length,
          );
          return (
            (index + (event.key === "ArrowRight" ? 1 : -1) + count) % count
          );
        });
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space" || lastInput.current !== "keyboard") return;
      event.preventDefault();
      lastInput.current = null;
      gestureRef.current({ type: "release", at: Date.now() });
    };
    const cancel = () => {
      lastInput.current = null;
      gestureRef.current({ type: "cancel" });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, []);

  useEffect(() => {
    setAwakeSupported("wakeLock" in navigator);
    setFullscreenSupported(Boolean(document.documentElement.requestFullscreen));
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast.info("Fullscreen isn't available right now.", {
        description: "Desk mode still works in this window.",
      });
    }
  }
  useEffect(() => {
    wakeWanted.current = awakeEnabled;
    let disposed = false;
    async function acquire() {
      if (
        !awakeEnabled ||
        !("wakeLock" in navigator) ||
        document.visibilityState !== "visible"
      )
        return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (disposed || !wakeWanted.current) {
          await lock.release();
          return;
        }
        wakeLock.current = lock;
        setAwake(true);
        lock.addEventListener("release", () => {
          if (!disposed) setAwake(false);
        });
      } catch {
        if (!disposed) {
          setAwake(false);
          toast.info("The browser couldn't keep the screen awake.", {
            description: "You can continue using desk mode.",
          });
        }
      }
    }
    if (awakeEnabled) void acquire();
    const visible = () => {
      if (
        document.visibilityState === "visible" &&
        awakeEnabled &&
        (!wakeLock.current || wakeLock.current.released)
      )
        void acquire();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visible);
      if (wakeLock.current) {
        void wakeLock.current.release();
        wakeLock.current = null;
      }
      setAwake(false);
    };
  }, [awakeEnabled]);

  const captureIsOpen = captureOpen || commandOpen;
  const capacity = snapshot?.capacity;
  return (
    <div className={styles.desk}>
      <header className={styles.header}>
        <Link href="/dashboard" className={styles.back}>
          <ArrowLeft size={16} />
          <span>Workspace</span>
        </Link>
        <Link href="/dashboard" className={styles.brand}>
          {PRODUCT.name}
          <span>.</span>
          <small>DESK</small>
        </Link>
        <div className={styles.tools}>
          <button
            aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            disabled={!fullscreenSupported}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Minimize size={18} /> : <Expand size={18} />}
          </button>
          <button
            aria-label={
              awakeEnabled ? "Allow screen to sleep" : "Keep screen awake"
            }
            aria-pressed={awakeEnabled}
            disabled={!awakeSupported}
            className={awake ? styles.toolActive : undefined}
            onClick={() => setAwakeEnabled((value) => !value)}
          >
            {awakeEnabled ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <div className={styles.connection} role="status">
        {disconnected ? (
          <>
            <WifiOff size={14} />
            <span>Connection interrupted · showing the last saved state</span>
            <button onClick={() => void refresh()}>Retry</button>
          </>
        ) : (
          <>
            <span className={styles.connectedDot} />
            <span>
              {mode === "demo" ? "Local demo" : "Workspace connected"}
              {awake ? " · Screen awake" : ""}
            </span>
          </>
        )}
      </div>
      <main className={styles.main}>
        {loading && !state ? (
          <div className={styles.empty}>
            <Loader2 size={29} className="spin" />
            <h1>Getting your next move ready.</h1>
          </div>
        ) : !state ? (
          <div className={styles.empty}>
            <WifiOff size={32} />
            <h1>Your desk couldn’t connect.</h1>
            <p>{error || "Please check your connection."}</p>
            <Button variant="primary" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : current ? (
          <>
            <div className={styles.nowLabel}>
              <span />
              NOW
              <span className={styles.focusStatus}>
                {snapshot?.timer ? "FOCUS IN PROGRESS" : "ONE CLEAR NEXT MOVE"}
              </span>
            </div>
            <div className={styles.taskContext}>
              {current.project || "Personal"}
              <span>/</span>
              {current.status === "in_progress"
                ? "In progress"
                : "Ready when you are"}
            </div>
            <h1 className={styles.title}>{current.title}</h1>
            <div
              className={styles.timer}
              aria-label={`${timerLabel(snapshot?.timer?.elapsed_seconds || 0)} elapsed focus time`}
            >
              <span>{timerLabel(snapshot?.timer?.elapsed_seconds || 0)}</span>
              <small>
                {snapshot?.timer
                  ? "ELAPSED FOCUS TIME"
                  : "FOCUS STARTS WITH ONE PRESS"}
              </small>
            </div>
            <div className={styles.metrics}>
              <div>
                <small>ESTIMATED REMAINING</small>
                <strong>{duration(current.remaining_minutes)}</strong>
              </div>
              <div>
                <small>DEADLINE</small>
                <strong>
                  {dateLabel(current.deadline, snapshot!.timezone)}
                </strong>
              </div>
              <div className={styles.taskRisk} data-risk={current.risk.level}>
                <small>DEADLINE RISK</small>
                <strong>
                  <Circle size={9} fill="currentColor" />
                  {current.risk.level === "safe"
                    ? "On track"
                    : current.risk.level}
                  <span>{Math.round(current.risk.score)}</span>
                </strong>
              </div>
            </div>
            <div className={styles.progress}>
              <div>
                <span style={{ width: `${current.progress_percent}%` }} />
              </div>
              <small>
                {Math.round(current.progress_percent)}% of estimated effort ·{" "}
                {duration(current.estimated_minutes)} total
              </small>
            </div>
            <p className={styles.riskReason}>
              {current.risk.explanation.at(-1)}
            </p>
            <div className={styles.actions}>
              <button
                disabled={disabled || Boolean(snapshot?.timer)}
                className={styles.start}
                onClick={() => void action(current.id, "start")}
              >
                <Play size={17} />
                Start
              </button>
              <button
                disabled={disabled || !snapshot?.timer}
                onClick={() => void action(current.id, "pause")}
              >
                <Pause size={17} />
                Pause
              </button>
              <button
                disabled={disabled}
                onClick={() => void action(current.id, "complete")}
              >
                <Check size={18} />
                Done
              </button>
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            <div className={styles.clearSymbol}>✳</div>
            <span className={styles.nowLabel}>NOTHING TO CHASE</span>
            <h1>A little breathing room.</h1>
            <p>
              No executable commitment is waiting. Capture a promise, or give a
              blocked commitment a next step in your workspace.
            </p>
            <Button
              variant="primary"
              disabled={disconnected}
              onClick={openCapture}
            >
              <Plus size={16} />
              Capture a commitment
            </Button>
          </div>
        )}
        {state && (
          <section className={styles.controlBar}>
            <div className={styles.capacity}>
              <div
                className={styles.trafficLight}
                data-signal={capacity?.signal}
                aria-label={`Capacity: ${capacity?.reason}`}
              >
                <i />
                <i />
                <i />
              </div>
              <div>
                <small>TODAY’S CAPACITY</small>
                <strong>
                  {capacity?.deficitMinutes
                    ? `${duration(capacity.deficitMinutes)} over capacity`
                    : capacity?.signal === "flashing_red"
                      ? "A deadline needs a decision now"
                      : capacity?.signal === "red"
                        ? "Your workload needs attention"
                        : capacity?.signal === "yellow"
                          ? "Almost at capacity"
                          : "Room to follow through"}
                </strong>
                <span>
                  {duration(capacity?.requiredMinutes || 0)} required /{" "}
                  {duration(capacity?.capacityMinutes || 0)} available
                </span>
                {capacity && capacity.signal !== "green" && (
                  <span>{capacity.reason}</span>
                )}
              </div>
            </div>
            <div className={styles.mechanicalWrap}>
              <button
                type="button"
                className={styles.mechanical}
                data-desk-button
                disabled={disabled}
                aria-label="Desk button: press to start, double press to complete, hold to capture"
                aria-describedby="desk-gesture-help"
                onPointerDown={(event) => {
                  if (event.button !== 0 || lastInput.current === "keyboard")
                    return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  lastInput.current = "pointer";
                  gesture({
                    type: "press",
                    id: current?.id ?? null,
                    at: Date.now(),
                  });
                }}
                onPointerUp={() => {
                  if (lastInput.current !== "pointer") return;
                  lastInput.current = null;
                  gesture({ type: "release", at: Date.now() });
                }}
                onPointerCancel={() => {
                  lastInput.current = null;
                  gesture({ type: "cancel" });
                }}
                onLostPointerCapture={() => {
                  if (lastInput.current === "pointer") {
                    lastInput.current = null;
                    gesture({ type: "cancel" });
                  }
                }}
                onClick={(event) => {
                  event.preventDefault();
                  if (event.detail === 0 && current && !lastInput.current)
                    void action(current.id, "start");
                }}
              >
                <Power size={27} />
              </button>
              <p id="desk-gesture-help">
                <strong>Press to start · double to finish</strong>
                <span>Hold to capture · Space works too</span>
              </p>
            </div>
            <button
              className={styles.add}
              disabled={disconnected}
              onClick={openCapture}
            >
              <Plus size={20} />
              <span>
                Add commitment<small>Voice or text · Ctrl / ⌘ K</small>
              </span>
            </button>
          </section>
        )}
        {next.length > 0 && (
          <section className={styles.next}>
            <button
              className={styles.nextToggle}
              aria-expanded={nextOpen}
              onClick={() => setNextOpen((value) => !value)}
            >
              <span>
                NEXT UP <small>{next.length}</small>
              </span>
              <ChevronDown
                size={16}
                className={nextOpen ? styles.rotated : undefined}
              />
            </button>
            {nextOpen && browsed && (
              <div className={styles.nextPreview}>
                <button
                  className={styles.browseArrow}
                  aria-label="Previous next commitment"
                  onClick={() =>
                    setBrowseIndex(
                      (index) => (index + next.length - 1) % next.length,
                    )
                  }
                >
                  <ChevronLeft size={20} />
                </button>
                <div>
                  <small>
                    {Math.min(browseIndex, next.length - 1) + 1} / {next.length}{" "}
                    · {browsed.project || "Personal"}
                  </small>
                  <strong>{browsed.title}</strong>
                  <p>
                    {duration(browsed.remaining_minutes)} ·{" "}
                    {dateLabel(browsed.deadline, snapshot!.timezone)}
                  </p>
                </div>
                <Button
                  disabled={disabled}
                  onClick={() => void action(browsed.id, "start")}
                >
                  <Play size={14} />
                  Start this
                </Button>
                <button
                  className={styles.browseArrow}
                  aria-label="Next commitment"
                  onClick={() =>
                    setBrowseIndex((index) => (index + 1) % next.length)
                  }
                >
                  <ChevronRight size={20} />
                </button>
              </div>
            )}
          </section>
        )}
      </main>
      <footer className={styles.footer}>
        <span>Protect your attention. The rest can wait.</span>
        <Link href="/today">
          Open today <ArrowRight size={13} />
        </Link>
      </footer>
      <Modal
        open={captureIsOpen}
        onOpenChange={(open) => {
          setCaptureOpen(open);
          if (!open) setCommandOpen(false);
        }}
        title="Get it out of your head"
        description="Type a promise, or press the microphone to capture with your voice."
        wide
      >
        <Capture
          onSaved={() => {
            setCaptureOpen(false);
            setCommandOpen(false);
          }}
        />
      </Modal>
    </div>
  );
}
