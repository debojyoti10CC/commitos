"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, Folder, Pencil, Search, Users, X } from "lucide-react";
import type { CapturedRecord, RecordKind } from "@/lib/records/types";
import { briefRecordTitle } from "@/lib/records/title";
import {
  deadlineProgress,
  legacyCommitmentToRecord,
} from "@/lib/records/organizer";
import { useApp } from "./app-provider";
import { Capture } from "./capture";
import { Button, Field, Modal } from "./ui";
import { dateLabel, deadlinePatchFromInput, inputDate, localDay } from "./format";
import styles from "./records-view.module.css";

const kinds: { value: RecordKind; label: string }[] = [
  { value: "task", label: "Task" },
  { value: "note", label: "Note" },
  { value: "idea", label: "Idea" },
  { value: "event", label: "Event" },
  { value: "reference", label: "Reference" },
];
const labels = {
  all: "Records",
  deadlines: "Dates",
  today: "Today",
  collections: "Collections",
  people: "People",
};
function timeRemaining(value: number | null, overdue: boolean) {
  if (value === null) return "Date unknown";
  const minutes = Math.max(1, Math.ceil(Math.abs(value) / 60000));
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    mins = minutes % 60;
  const result = days
    ? `${days}d ${hours}h`
    : hours
      ? `${hours}h ${mins}m`
      : `${minutes}m`;
  return overdue ? `${result} overdue` : `${result} remaining`;
}
function percentage(value: number) {
  return value > 0 && value < 1 ? "<1" : String(Math.round(value));
}

export function RecordsView({
  mode = "all",
  compact = false,
}: {
  mode?: keyof typeof labels;
  compact?: boolean;
}) {
  const { state } = useApp();
  const [search, setSearch] = useState(""),
    [collection, setCollection] = useState(""),
    [person, setPerson] = useState(""),
    [clock, setClock] = useState(Date.now()),
    [editing, setEditing] = useState<CapturedRecord | null>(null);
  useEffect(() => {
    const query = () => {
      const params = new URLSearchParams(window.location.search);
      setSearch(params.get("search") || "");
      setCollection(params.get("collection") || "");
      setPerson(params.get("person") || "");
    };
    query();
    window.addEventListener("popstate", query);
    return () => window.removeEventListener("popstate", query);
  }, [mode]);
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);
  const records = useMemo(
    () =>
      state
        ? [
            ...(state.records || []).filter(
              (record) => record.status === "active",
            ),
            ...state.commitments
              .filter(
                (commitment) =>
                  !["done", "cancelled"].includes(commitment.status),
              )
              .map(legacyCommitmentToRecord),
          ].sort((a, b) => b.created_at.localeCompare(a.created_at))
        : [],
    [state],
  );
  const collections = useMemo(
    () =>
      Array.from(new Set(records.map((record) => record.collection))).sort(
        (a, b) => a.localeCompare(b),
      ),
    [records],
  );
  const people = useMemo(
    () =>
      Array.from(new Set(records.flatMap((record) => record.contacts))).sort(
        (a, b) => a.localeCompare(b),
      ),
    [records],
  );
  if (!state) return null;
  const tz = state.settings.timezone,
    today = localDay(tz, new Date(clock)),
    now = new Date(clock);
  const filtered = records
    .filter(
      (record) =>
        (mode !== "deadlines" || !!record.deadline) &&
        (mode !== "today" ||
          localDay(tz, new Date(record.created_at)) === today ||
          (!!record.deadline &&
            localDay(tz, new Date(record.deadline)) === today)) &&
        (mode !== "people" || record.contacts.length > 0) &&
        (!collection || record.collection === collection) &&
        (!person ||
          record.contacts.some(
            (contact) => contact.toLowerCase() === person.toLowerCase(),
          )) &&
        `${record.title} ${record.content} ${record.collection} ${record.contacts.join(" ")} ${record.tags.join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      mode === "deadlines"
        ? (a.deadline || "z").localeCompare(b.deadline || "z")
        : b.created_at.localeCompare(a.created_at),
    );
  const visible = compact ? filtered.slice(0, 12) : filtered;
  const showIndex =
    mode === "all" || mode === "collections" || mode === "people";
  const indexNames = mode === "people" ? people : collections;
  return (
    <div className={styles.view}>
      <header className={styles.titlebar}>
        <h1>{labels[mode]}</h1>
      </header>
      <div className={styles.windowBody}>
        <Capture compact />
        <div
          className={`${styles.layout} ${!showIndex ? styles.withoutIndex : ""}`}
        >
          <section className={styles.feed} aria-label={labels[mode]}>
            <div className={styles.toolbar}>
              <label className={styles.search}>
                <Search size={16} />
                <input
                  aria-label="Search records"
                  placeholder="Search records…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button
                    aria-label="Clear search"
                    onClick={() => setSearch("")}
                  >
                    <X size={14} />
                  </button>
                )}
              </label>
              <span className={styles.resultCount}>
                {filtered.length} {filtered.length === 1 ? "record" : "records"}
              </span>
            </div>
            {(collection || person) && (
              <div className={styles.filters}>
                {collection && (
                  <button
                    onClick={() => setCollection("")}
                    aria-label={`Clear collection filter ${collection}`}
                  >
                    {collection}
                    <X size={13} />
                  </button>
                )}
                {person && (
                  <button
                    onClick={() => setPerson("")}
                    aria-label={`Clear person filter ${person}`}
                  >
                    {person}
                    <X size={13} />
                  </button>
                )}
              </div>
            )}
            <div className={styles.cards}>
              {visible.length ? (
                visible.map((record) => (
                  <RecordCard
                    key={record.id}
                    record={record}
                    now={now}
                    timezone={tz}
                    onEdit={() => setEditing(record)}
                  />
                ))
              ) : (
                <div className={styles.empty}>
                  <p>
                    {records.length
                      ? "No matching records."
                      : "No records yet. Type something above and Save."}
                  </p>
                  {(search || collection || person) && (
                    <Button
                      onClick={() => {
                        setSearch("");
                        setCollection("");
                        setPerson("");
                      }}
                    >
                      Clear filters
                    </Button>
                  )}
                </div>
              )}
            </div>
            {compact && filtered.length > visible.length && (
              <Link className={styles.viewAll} href="/dashboard">
                View all {filtered.length} records
              </Link>
            )}
          </section>
          {showIndex && (
            <aside
              className={styles.index}
              aria-label={
                mode === "people" ? "Filter by person" : "Filter by collection"
              }
            >
              <h2>{mode === "people" ? "People" : "Collections"}</h2>
              <button
                className={`${styles.indexItem} ${!collection && !person ? styles.selected : ""}`}
                aria-pressed={!collection && !person}
                onClick={() => {
                  setCollection("");
                  setPerson("");
                }}
              >
                <span>All</span>
                <span>
                  {mode === "people"
                    ? records.filter((record) => record.contacts.length).length
                    : records.length}
                </span>
              </button>
              {indexNames.map((name) => {
                const related = records.filter((record) =>
                  mode === "people"
                    ? record.contacts.includes(name)
                    : record.collection === name,
                );
                const selected =
                  mode === "people" ? person === name : collection === name;
                return (
                  <button
                    key={name}
                    className={`${styles.indexItem} ${selected ? styles.selected : ""}`}
                    aria-pressed={selected}
                    onClick={() => {
                      if (mode === "people") {
                        setPerson(name);
                        setCollection("");
                      } else {
                        setCollection(name);
                        setPerson("");
                      }
                    }}
                  >
                    {mode === "people" ? (
                      <Users size={14} />
                    ) : (
                      <Folder size={14} />
                    )}
                    <span>{name}</span>
                    <span>{related.length}</span>
                  </button>
                );
              })}
              {!indexNames.length && (
                <p>
                  {mode === "people" ? "No people yet." : "No collections yet."}
                </p>
              )}
            </aside>
          )}
        </div>
      </div>
      {editing && (
        <RecordCorrection
          record={editing}
          timezone={tz}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RecordCard({
  record,
  now,
  timezone,
  onEdit,
}: {
  record: CapturedRecord;
  now: Date;
  timezone: string;
  onEdit: () => void;
}) {
  const progress = deadlineProgress(record.created_at, record.deadline, now);
  const legacy = record.source === "legacy",
    heading = briefRecordTitle(record.title, record.kind, record.content);
  const dateWarnings = record.interpretation.warnings.filter((warning) =>
    /date|time|deadline|day|month|year|ambig|precise/i.test(warning),
  );
  return (
    <article className={styles.card}>
      <div className={styles.cardTop}>
        <span className={styles.collectionLabel}>{record.collection}</span>
        <span className={styles.kind}>{record.kind}</span>
        {!legacy && (
          <button
            className={styles.correct}
            aria-label={`Edit ${heading}`}
            onClick={onEdit}
          >
            <Pencil size={13} />
            Edit
          </button>
        )}
      </div>
      <h3>{heading}</h3>
      {progress.has_deadline && progress.remaining_percent !== null && (
        <div className={styles.deadline} data-overdue={progress.overdue}>
          <div className={styles.deadlineNumbers}>
            <strong>
              {percentage(progress.remaining_percent)}%{" "}
              <span>time window left</span>
            </strong>
            <span>
              {timeRemaining(
                record.deadline
                  ? Date.parse(record.deadline) - now.getTime()
                  : null,
                progress.overdue,
              )}
            </span>
          </div>
          <div
            className={styles.segmentedBar}
            role="meter"
            aria-label={`Time window remaining from capture until ${heading} deadline`}
            aria-valuenow={progress.remaining_percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${progress.remaining_percent}%` }} />
          </div>
          <div className={styles.deadlineAxis}>
            <span>
              Captured{" "}
              {new Intl.DateTimeFormat("en-IN", {
                month: "short",
                day: "numeric",
                timeZone: timezone,
              }).format(new Date(record.created_at))}
            </span>
            <span>{dateLabel(record.deadline, timezone)}</span>
          </div>
        </div>
      )}
      {record.contacts.length > 0 && (
        <div className={styles.recordMeta}>
          <Users size={13} />
          {record.contacts.join(", ")}
        </div>
      )}
      {dateWarnings.length > 0 && (
        <div className={styles.warning}>
          {dateWarnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </div>
      )}
      <details className={styles.details}>
        <summary>
          Original text
          <ChevronDown size={13} />
        </summary>
        <div className={styles.rawContent}>{record.content}</div>
      </details>
    </article>
  );
}

function RecordCorrection({
  record,
  timezone,
  onClose,
}: {
  record: CapturedRecord;
  timezone: string;
  onClose: () => void;
}) {
  const { mutate } = useApp();
  const [initialDate] = useState(() => ({
    value: inputDate(record.deadline, timezone),
    timezone,
  }));
  const [form, setForm] = useState({
      title: briefRecordTitle(record.title, record.kind, record.content),
      content: record.content,
      kind: record.kind,
      collection: record.collection,
      deadline: initialDate.value,
    }),
    [saving, setSaving] = useState(false);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit record"
      description="Change the heading, original text, or date."
      wide
    >
      <form
        className="form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          const { deadline, ...details } = form;
          const result = await mutate(
            `/api/records/${record.id}`,
            {
              ...details,
              ...deadlinePatchFromInput(deadline, initialDate.value, initialDate.timezone),
            },
            "PATCH",
          );
          setSaving(false);
          if (result) onClose();
        }}
      >
        <Field label="Heading">
          <input
            required
            maxLength={60}
            value={form.title}
            onChange={(event) =>
              setForm({ ...form, title: event.target.value })
            }
          />
        </Field>
        <Field label="Original text">
          <textarea
            required
            value={form.content}
            onChange={(event) =>
              setForm({ ...form, content: event.target.value })
            }
          />
        </Field>
        <div className="form-grid">
          <Field label="Type">
            <select
              value={form.kind}
              onChange={(event) =>
                setForm({ ...form, kind: event.target.value as RecordKind })
              }
            >
              {kinds.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Collection">
            <input
              required
              value={form.collection}
              onChange={(event) =>
                setForm({ ...form, collection: event.target.value })
              }
            />
          </Field>
        </div>
        <Field
          label={`Date · ${initialDate.timezone}`}
          hint="Leave empty when there is no date."
        >
          <input
            type="datetime-local"
            value={form.deadline}
            onChange={(event) =>
              setForm({ ...form, deadline: event.target.value })
            }
          />
        </Field>
        <div className="modal-footer">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
