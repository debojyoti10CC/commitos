import { describe, expect, it } from "vitest";
import {
  emptyDeskGesture,
  nextDeskGestureDeadline,
  reduceDeskGesture,
} from "@/lib/device/gesture";

describe("desk button gesture decisions", () => {
  it("delays a single press and starts the originally displayed commitment exactly once", () => {
    const down = reduceDeskGesture(emptyDeskGesture(), {
      type: "press",
      id: "original",
      at: 0,
    });
    const up = reduceDeskGesture(down.state, { type: "release", at: 100 });
    expect(up.actions).toEqual([]);
    expect(nextDeskGestureDeadline(up.state)).toBe(420);
    expect(
      reduceDeskGesture(up.state, { type: "advance", at: 419 }).actions,
    ).toEqual([]);
    const fired = reduceDeskGesture(up.state, { type: "advance", at: 420 });
    expect(fired.actions).toEqual([{ type: "start", id: "original" }]);
    expect(
      reduceDeskGesture(fired.state, { type: "advance", at: 1000 }).actions,
    ).toEqual([]);
  });
  it("a double press cancels the start and completes the first commitment, even after recommendation changes", () => {
    const first = reduceDeskGesture(emptyDeskGesture(), {
      type: "press",
      id: "original",
      at: 0,
    });
    const release = reduceDeskGesture(first.state, { type: "release", at: 50 });
    const second = reduceDeskGesture(release.state, {
      type: "press",
      id: "new-recommendation",
      at: 200,
    });
    const waiting = reduceDeskGesture(second.state, {
      type: "advance",
      at: 400,
    });
    expect(waiting.actions).toEqual([]);
    const completed = reduceDeskGesture(waiting.state, {
      type: "release",
      at: 430,
    });
    expect(completed.actions).toEqual([{ type: "complete", id: "original" }]);
    expect(completed.state.pending).toBeNull();
  });
  it("a hold opens capture once and release does not start or complete anything", () => {
    const down = reduceDeskGesture(emptyDeskGesture(), {
      type: "press",
      id: "task",
      at: 0,
    });
    const hold = reduceDeskGesture(down.state, { type: "advance", at: 700 });
    expect(hold.actions).toEqual([{ type: "capture" }]);
    const later = reduceDeskGesture(hold.state, { type: "advance", at: 900 });
    expect(later.actions).toEqual([]);
    const released = reduceDeskGesture(later.state, {
      type: "release",
      at: 1000,
    });
    expect(released.actions).toEqual([]);
    expect(nextDeskGestureDeadline(released.state)).toBeNull();
  });
  it("holding the second press suppresses the pending single and double actions", () => {
    const first = reduceDeskGesture(emptyDeskGesture(), {
      type: "press",
      id: "task",
      at: 0,
    });
    const up = reduceDeskGesture(first.state, { type: "release", at: 50 });
    const second = reduceDeskGesture(up.state, {
      type: "press",
      id: "task",
      at: 150,
    });
    const hold = reduceDeskGesture(second.state, { type: "advance", at: 850 });
    expect(hold.actions).toEqual([{ type: "capture" }]);
    expect(
      reduceDeskGesture(hold.state, { type: "release", at: 900 }).actions,
    ).toEqual([]);
  });
  it("cancellation removes queued actions and a hold still supports an empty desk", () => {
    const down = reduceDeskGesture(emptyDeskGesture(), {
      type: "press",
      id: "task",
      at: 0,
    });
    const up = reduceDeskGesture(down.state, { type: "release", at: 40 });
    const cancel = reduceDeskGesture(up.state, { type: "cancel" });
    expect(
      reduceDeskGesture(cancel.state, { type: "advance", at: 1000 }).actions,
    ).toEqual([]);
    const empty = reduceDeskGesture(emptyDeskGesture(), {
      type: "press",
      id: null,
      at: 0,
    });
    expect(
      reduceDeskGesture(empty.state, { type: "release", at: 800 }).actions,
    ).toEqual([{ type: "capture" }]);
  });
  it("late second presses are independent rather than silently completing a different commitment", () => {
    const down = reduceDeskGesture(emptyDeskGesture(), {
      type: "press",
      id: "first",
      at: 0,
    });
    const up = reduceDeskGesture(down.state, { type: "release", at: 30 });
    const late = reduceDeskGesture(up.state, {
      type: "press",
      id: "second",
      at: 500,
    });
    expect(late.actions).toEqual([{ type: "start", id: "first" }]);
    const released = reduceDeskGesture(late.state, {
      type: "release",
      at: 550,
    });
    expect(
      reduceDeskGesture(released.state, { type: "advance", at: 900 }).actions,
    ).toEqual([{ type: "start", id: "second" }]);
  });
});
