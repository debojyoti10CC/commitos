"use client";
import { useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  Check,
  MoreHorizontal,
  Play,
  Timer,
  CalendarClock,
  Pencil,
  Trash2,
  Pause,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { STATUSES, PRIORITIES, TYPES, type Commitment } from "@/lib/types";
import { calculateRiskScore } from "@/lib/risk/engine";
import { useApp } from "./app-provider";
import { Button, Field, Modal, RiskBadge, cn } from "./ui";
export { RiskBadge } from "./ui";
import { clockTime, dateLabel, duration, fromInput, inputDate } from "./format";
export function CommitmentEditor({
  commitment,
  open,
  onClose,
}: {
  commitment: Commitment;
  open: boolean;
  onClose: () => void;
}) {
  const { state, mutate } = useApp();
  const tz = state?.settings.timezone || "Asia/Kolkata";
  const [form, setForm] = useState({ ...commitment }),
    [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    const result = await mutate(
      `/api/commitments/${commitment.id}`,
      {
        title: form.title,
        description: form.description,
        project: form.project,
        contact_name: form.contact_name,
        organization: form.organization,
        deadline: form.deadline,
        check_in_at: form.check_in_at,
        estimated_minutes: form.estimated_minutes,
        next_action: form.next_action,
        priority: form.priority,
        status: form.status,
        commitment_type: form.commitment_type,
      },
      "PATCH",
    );
    setSaving(false);
    if (result) {
      toast.success("Commitment updated");
      onClose();
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Edit commitment"
      description="Make a correction. The plan and risk will update automatically."
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="form-stack"
      >
        <Field label="Commitment">
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <div className="form-grid">
          <Field label="Deadline">
            <input
              type="datetime-local"
              value={inputDate(form.deadline, tz)}
              onChange={(e) =>
                setForm({ ...form, deadline: fromInput(e.target.value, tz) })
              }
            />
          </Field>
          <Field label="Check-in">
            <input
              type="datetime-local"
              value={inputDate(form.check_in_at, tz)}
              onChange={(e) =>
                setForm({ ...form, check_in_at: fromInput(e.target.value, tz) })
              }
            />
          </Field>
          <Field label="Estimated minutes">
            <input
              type="number"
              min="1"
              max="100000"
              value={form.estimated_minutes}
              onChange={(e) =>
                setForm({ ...form, estimated_minutes: Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Priority">
            <select
              value={form.priority}
              onChange={(e) =>
                setForm({
                  ...form,
                  priority: e.target.value as Commitment["priority"],
                })
              }
            >
              {PRIORITIES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) =>
                setForm({
                  ...form,
                  status: e.target.value as Commitment["status"],
                })
              }
            >
              {STATUSES.map((v) => (
                <option value={v} key={v}>
                  {v.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select
              value={form.commitment_type}
              onChange={(e) =>
                setForm({
                  ...form,
                  commitment_type: e.target
                    .value as Commitment["commitment_type"],
                })
              }
            >
              {TYPES.map((v) => (
                <option value={v} key={v}>
                  {v.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Project (optional)">
            <input
              value={form.project || ""}
              list="project-names"
              onChange={(e) =>
                setForm({ ...form, project: e.target.value || null })
              }
            />
          </Field>
          <Field label="Person (optional)">
            <input
              value={form.contact_name || ""}
              onChange={(e) =>
                setForm({ ...form, contact_name: e.target.value || null })
              }
            />
          </Field>
          <Field label="Organization">
            <input
              value={form.organization || ""}
              onChange={(e) =>
                setForm({ ...form, organization: e.target.value || null })
              }
            />
          </Field>
          <Field label="Next action">
            <input
              value={form.next_action || ""}
              onChange={(e) =>
                setForm({ ...form, next_action: e.target.value || null })
              }
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <datalist id="project-names">
          {state?.projects.map((p) => (
            <option key={p.id}>{p.name}</option>
          ))}
        </datalist>
        <div className="modal-footer">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function CommitmentActions({
  commitment,
  full = false,
}: {
  commitment: Commitment;
  full?: boolean;
}) {
  const { state, mutate } = useApp(),
    [edit, setEdit] = useState(false),
    [reschedule, setReschedule] = useState(false),
    [deadline, setDeadline] = useState(""),
    [deleteOpen, setDeleteOpen] = useState(false);
  const tz = state?.settings.timezone || "Asia/Kolkata";
  const action = async (name: string, body?: unknown) => {
    const result = await mutate(
      `/api/commitments/${commitment.id}/${name}`,
      body,
    );
    if (result)
      toast.success(
        name === "complete"
          ? "Commitment completed"
          : name === "start"
            ? "Focus session started"
            : name === "pause"
              ? "Session paused"
              : name === "checkin"
                ? "Check-in marked sent"
                : `Commitment ${name}d`,
      );
  };
  return (
    <>
      <div className="commitment-actions">
        {full &&
          commitment.status !== "done" &&
          commitment.status !== "cancelled" && (
            <>
              <Button
                variant="primary"
                onClick={() =>
                  void action(
                    commitment.status === "in_progress" ? "pause" : "start",
                  )
                }
              >
                {commitment.status === "in_progress" ? (
                  <Pause size={15} />
                ) : (
                  <Play size={15} />
                )}{" "}
                {commitment.status === "in_progress" ? "Pause" : "Start focus"}
              </Button>
              <Button
                onClick={() => void action("complete")}
                aria-label={`Complete ${commitment.title}`}
              >
                <Check size={16} />
                <span className="desktop-label">Done</span>
              </Button>
            </>
          )}
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <Button
              variant="ghost"
              className="icon-button"
              aria-label={`Actions for ${commitment.title}`}
            >
              <MoreHorizontal size={19} />
            </Button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="dropdown" align="end" sideOffset={8}>
              <Dropdown.Item onSelect={() => setEdit(true)}>
                <Pencil size={15} />
                Edit commitment
              </Dropdown.Item>
              <Dropdown.Item onSelect={() => void action("start")}>
                <Play size={15} />
                Start focus
              </Dropdown.Item>
              <Dropdown.Item onSelect={() => void action("complete")}>
                <Check size={15} />
                Mark done
              </Dropdown.Item>
              <Dropdown.Item
                onSelect={() => void action("snooze", { minutes: 30 })}
              >
                <Timer size={15} />
                Snooze 30 minutes
              </Dropdown.Item>
              <Dropdown.Item
                onSelect={() => {
                  setDeadline(inputDate(commitment.deadline, tz));
                  setReschedule(true);
                }}
              >
                <CalendarClock size={15} />
                Reschedule
              </Dropdown.Item>
              {commitment.check_in_at &&
                !commitment.metadata.check_in_completed_at && (
                  <Dropdown.Item onSelect={() => void action("checkin", {})}>
                    <Check size={15} />
                    Check-in sent
                  </Dropdown.Item>
                )}
              <Dropdown.Separator />
              <Dropdown.Item
                onSelect={() =>
                  void mutate(
                    `/api/commitments/${commitment.id}`,
                    { status: "waiting" },
                    "PATCH",
                  )
                }
              >
                Set waiting
              </Dropdown.Item>
              <Dropdown.Item
                onSelect={() =>
                  void mutate(
                    `/api/commitments/${commitment.id}`,
                    { status: "blocked" },
                    "PATCH",
                  )
                }
              >
                Set blocked
              </Dropdown.Item>
              <Dropdown.Item
                onSelect={() =>
                  void mutate(
                    `/api/commitments/${commitment.id}`,
                    { status: "cancelled" },
                    "PATCH",
                  )
                }
              >
                Cancel commitment
              </Dropdown.Item>
              <Dropdown.Separator />
              <Dropdown.Item
                className="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 size={15} />
                Delete
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
      {edit && (
        <CommitmentEditor
          commitment={commitment}
          open={edit}
          onClose={() => setEdit(false)}
        />
      )}
      <Modal
        open={reschedule}
        onOpenChange={setReschedule}
        title="Choose a new deadline"
        description={commitment.title}
      >
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await mutate(
              `/api/commitments/${commitment.id}/reschedule`,
              { deadline: fromInput(deadline, tz) },
            );
            if (result) {
              setReschedule(false);
              toast.success("Deadline updated");
            }
          }}
        >
          <Field label={`Deadline · ${tz}`}>
            <input
              required
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </Field>
          <Button variant="primary" type="submit">
            Reschedule commitment
          </Button>
        </form>
      </Modal>
      <Modal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this commitment?"
        description="This also removes its local sessions and reminders."
      >
        <p>{commitment.title}</p>
        <div className="modal-footer">
          <Button onClick={() => setDeleteOpen(false)}>Keep commitment</Button>
          <Button
            variant="danger"
            onClick={async () => {
              const result = await mutate(
                `/api/commitments/${commitment.id}`,
                undefined,
                "DELETE",
              );
              if (result) {
                setDeleteOpen(false);
                toast.success("Commitment deleted");
              }
            }}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </>
  );
}
export function CommitmentRow({
  commitment,
  index,
  showRisk = true,
}: {
  commitment: Commitment;
  index?: number;
  showRisk?: boolean;
}) {
  const { state } = useApp();
  const [details, setDetails] = useState(false);
  const tz = state?.settings.timezone || "Asia/Kolkata";
  const risk = state ? calculateRiskScore(commitment, state) : null;
  return (
    <>
      <div className="commitment-row">
        {index !== undefined ? (
          <span className="row-index">
            {String(index + 1).padStart(2, "0")}
          </span>
        ) : (
          <button
            className={cn(
              "complete-circle",
              commitment.status === "done" && "is-done",
            )}
            onClick={() => setDetails(true)}
            aria-label={`View ${commitment.title}`}
          >
            {commitment.status === "done" && <Check size={14} />}
          </button>
        )}
        <button className="row-main" onClick={() => setDetails(true)}>
          <span className="row-title">{commitment.title}</span>
          <span className="row-meta">
            {commitment.project && (
              <>
                <span className="project-dot" />
                {commitment.project}
                <span>·</span>
              </>
            )}
            {dateLabel(commitment.deadline, tz)}
            {commitment.status === "waiting" && <span>· Waiting</span>}
            {commitment.status === "blocked" && <span>· Blocked</span>}
          </span>
        </button>
        <span className="row-duration">
          {duration(commitment.remaining_minutes)}
        </span>
        {showRisk && risk && <RiskBadge level={risk.level} />}
        <CommitmentActions commitment={commitment} />
      </div>
      <Modal
        open={details}
        onOpenChange={setDetails}
        title={commitment.title}
        description={commitment.project || "Commitment details"}
        wide
      >
        <div className="detail-metrics">
          <div>
            <small>DEADLINE</small>
            <strong>{dateLabel(commitment.deadline, tz)}</strong>
          </div>
          <div>
            <small>REMAINING</small>
            <strong>{duration(commitment.remaining_minutes)}</strong>
          </div>
          <div>
            <small>STATUS</small>
            <strong>{commitment.status.replace("_", " ")}</strong>
          </div>
        </div>
        {commitment.next_action && (
          <p className="next-action">
            <ArrowUpRight size={18} />
            {commitment.next_action}
          </p>
        )}
        {commitment.description && (
          <p className="body-copy">{commitment.description}</p>
        )}
        {risk && (
          <div className="risk-explanation">
            <RiskBadge level={risk.level} score={risk.score} />
            <ul>
              {risk.explanation.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {commitment.check_in_at && (
          <p className="muted">
            Check-in with {commitment.contact_name || "your contact"} at{" "}
            {clockTime(commitment.check_in_at, tz)}.
          </p>
        )}
        <div className="modal-footer">
          <CommitmentActions commitment={commitment} full />
        </div>
      </Modal>
    </>
  );
}
