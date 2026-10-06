export const DESK_SINGLE_DELAY = 320;
export const DESK_HOLD_DELAY = 700;

export interface DeskGestureState {
  pressed: {
    id: string | null;
    at: number;
    second: boolean;
    held: boolean;
  } | null;
  pending: { id: string; due: number } | null;
}
export type DeskGestureEvent =
  | { type: "press"; id: string | null; at: number }
  | { type: "release"; at: number }
  | { type: "advance"; at: number }
  | { type: "cancel" };
export type DeskGestureAction =
  | { type: "start" | "complete"; id: string }
  | { type: "capture" };

export function emptyDeskGesture(): DeskGestureState {
  return { pressed: null, pending: null };
}

/** Pure gesture decisions. The caller owns clocks, timers, browser events, and API mutations. */
export function reduceDeskGesture(
  previous: DeskGestureState,
  event: DeskGestureEvent,
): { state: DeskGestureState; actions: DeskGestureAction[] } {
  const state: DeskGestureState = {
    pressed: previous.pressed ? { ...previous.pressed } : null,
    pending: previous.pending ? { ...previous.pending } : null,
  };
  const actions: DeskGestureAction[] = [];
  if (event.type === "cancel") return { state: emptyDeskGesture(), actions };

  // A second down suspends the single action while the second gesture is resolved.
  if (event.type === "press") {
    if (state.pressed) return { state, actions };
    if (state.pending && event.at >= state.pending.due) {
      actions.push({ type: "start", id: state.pending.id });
      state.pending = null;
    }
    const first = state.pending;
    state.pressed = {
      id: first?.id ?? event.id,
      at: event.at,
      second: Boolean(first),
      held: false,
    };
    state.pending = null;
    return { state, actions };
  }

  if (
    state.pressed &&
    !state.pressed.held &&
    event.at - state.pressed.at >= DESK_HOLD_DELAY
  ) {
    state.pressed.held = true;
    state.pending = null;
    actions.push({ type: "capture" });
  }
  if (event.type === "release" && state.pressed) {
    const press = state.pressed;
    state.pressed = null;
    if (!press.held && press.id) {
      if (press.second) actions.push({ type: "complete", id: press.id });
      else state.pending = { id: press.id, due: event.at + DESK_SINGLE_DELAY };
    }
  }
  if (
    event.type === "advance" &&
    !state.pressed &&
    state.pending &&
    event.at >= state.pending.due
  ) {
    actions.push({ type: "start", id: state.pending.id });
    state.pending = null;
  }
  return { state, actions };
}

export function nextDeskGestureDeadline(
  state: DeskGestureState,
): number | null {
  if (state.pressed && !state.pressed.held)
    return state.pressed.at + DESK_HOLD_DELAY;
  return state.pending?.due ?? null;
}
