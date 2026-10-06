# Verification — automatic records

Verified on 6 October 2026 with Node.js 24, Next.js 16.3.8, React 19.3, and Vitest 5.0.3.

| Check                       | Result                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and service tests      | 253 tests passed across 19 files.                                                                                                                   |
| TypeScript                  | Passed independently and as part of the final production build.                                                                       |
| Production build            | Compiled, type checked, and generated all pages.                                                                                                    |
| Records HTTP workflow       | 10 acceptance groups passed before the current voice upgrade.                                                                                        |
| Compatibility HTTP workflow | 14 acceptance groups passed for existing stored tasks and integration APIs.                                                                         |
| PostgreSQL migration        | 34 preservation, rollback, ownership, and access-control assertions passed in embedded PostgreSQL with pgcrypto and Supabase-compatible auth stubs. |
| Browser workflow            | Search, original-text disclosure, edit dialog, timezone saving/validation, Dates, Collections, person grouping, and local entry verified in the classic interface.           |
| Phone layout                | 375px viewport inspected; capture controls, Dates, and person filtering worked with no horizontal overflow.                         |
| Private build assets        | All 25 deployment traces checked; local data, environment files, and the voice runtime/model excluded. The Python worker is explicitly traced.         |
| Live Supabase schema        | Both migrations applied in one SQL Editor transaction; 16 tables, all with RLS enabled. Anonymous reads and direct client writes denied; save RPC limited to the server role. |
| Live server connection      | Auth admin and state-load RPC connected successfully. Unauthenticated app API returned 401; protected pages redirected to sign-in. Exact local auth origin/callback configured. |
| Local capture import        | Nine regressions passed for preservation, ownership, replay, collision rejection, and concurrent merge. Import defaults to dry-run and verifies the target Auth account. |
| Live account persistence    | Two original captures imported into the confirmed account; local bytes unchanged. Repeat import performed no save, and browser reload showed all three account records. |
| Local voice runtime         | 12 Python tests passed; installed dependencies passed pip check. Synthetic English WAV/WebM transcribed accurately; silence and noise returned empty text. |
| Audio-to-record integration | Seven checks passed using real local Whisper and isolated file storage: two correctly dated records, brief headings, source preservation, disk reload, replay safety, silence, malformed audio, and concurrent-request rejection. |

## Interface and headings

The compact interface uses beveled controls and striped title bars, with teal, purple, and amber accents. Checked normal-text contrast pairs are at least 4.77:1. The local entry screen opens the existing workspace directly, with no credential form or new demo session; account forms require configured account storage. Decorative command menus, notification history, duplicate transcript previews, and integration settings were removed. Every visible navigation link and record control has a working purpose. The full original statement stays in a collapsed Original text disclosure. Eighteen title tests cover brief headings, conversational filler, dates, meaningful numbers, names, negation, custom headings, and references. The classic palette stays readable for previously saved dark-theme preferences. Twelve correction regressions prove that an unchanged date is omitted from edits, retaining exact seconds, offsets, repeated daylight-saving times, and concurrent date changes; explicit date changes and removal still work.

## Capture and countdown proof

A single capture containing an assignment, idea, ordinary note, and URL saved four records, grouped into the matching named collection and Notes. The original wording was retained. Undated records displayed no countdown bar. The assignment displayed October 10 at 12:00 AM and a time-window percentage calculated from its capture time to its deadline.

The reported input `IIT submission assignment by 10th October 12 a.m. and I need to get an update` previously became October 12. Regression tests now prove October 10 at 00:00 in Asia/Kolkata. Date-first and month-first ordinals, spoken dates, AM/PM, date numbers versus clock numbers, invalid dates, and timezone clock changes are covered. The existing reported record was corrected through the records service without changing its original content, creation time, source, capture ID, or other records.

Voice capture now records microphone audio and uses local faster-whisper 1.2.1 with the multilingual small model on CPU/int8. An explicit Stop and save transcribes, organizes, and files the records; pauses, silence, microphone errors, and the automatic recording limit never silently submit. Failed transcription keeps the in-page audio for retry, and failed persistence keeps the transcript and request ID. Authenticated route tests check origin/ownership and recognition context; stream tests enforce the byte cap even with a false Content-Length. Python tests check decoding bounds, offline loading, silence/noise, vocabulary sanitation, and denial of external media resources.

A 7.253-second synthetic English utterance became exactly “I need to submit my assignment for IIT Patna by 10 October at 12 a.m. Call Ravi tomorrow at 10 a.m.” WebM transcription took about 5.7 seconds in the worker smoke test. The application bridge and records service saved two tasks with short headings and independent correct deadlines, then loaded identical records from disk. A retry caused no extra version increment. These tests used synthetic SAPI English speech, not a human Indian-accent recording; actual microphone quality and Hindi accuracy remain untested.

Conversational interpretation now handles polite, passive, filler, event, and idea phrasing and separates explicit second requests before date parsing. The reported Celo sentence now produces a submission due October 7 at 10 a.m. and a separate 8 a.m. check, while retaining the conditional noon extension in the original wording with a warning. The AM/PM choice and inherited date are identified as inferences. Known spoken names resolve with whole-name boundaries. Garbled fragments remain undated notes; conflicting noon/night wording produces a warning instead of a fabricated deadline. Original transcript chunks, explicit associations, and locally resolved dates remain preserved under optional enrichment.

Mocked AI-provider tests verify source preservation, local fallback, prevention of invented dates/people, preservation of locally parsed dates when AI proposes a different date, and retention of unknown/invalid date warnings. No live Gemini request was used for verification.

## Persistence and compatibility

Records HTTP checks cover mixed-kind capture, disk reload, private reads, replay-safe retries, corrections, owner isolation, invalid input/date/origin rejection, the date-first speech regression, and the primary routes. Local `localhost` and `127.0.0.1` aliases work on the same development port with an explicit `APP_URL`; Vercel accepts only its own deployment host in addition to the canonical origin. A hosted-runtime regression proves an unconfigured server returns an actionable 503 before attempting file writes. Vercel deployments require Supabase environment variables; local file storage is blocked in serverless functions. Prerendered legacy Desk links use Next's browser redirect to the records dashboard.

Eight concurrent retries with one capture key produced one record and one version increment. Changed text or source under the same request key was rejected. Existing task/session data remains intact and active stored tasks appear through a read-only record adapter.

The second database migration preserves existing rows/settings/effort. PostgreSQL checks cover omitted and empty old-client record arrays, stale-version and constraint rollback, cross-owner writes, immutable capture provenance, owner-scoped reads, denied client writes, and service-only RPC access. Auth stubs do not replace live Supabase Auth acceptance.

## Repeat the checks

```bash
npm ci
npm test
npm run typecheck
npm run build
# After scripts/setup-voice.ps1:
.voice/venv/Scripts/python.exe -m unittest discover -s tests -p test_voice_runtime.py
```

In a separate terminal, start local demo mode with `npm run start -- --port 3001`, then run:

```bash
node scripts/test-records-http.mjs
node scripts/test-http.mjs
```

Set `CHECK_ORIGIN` to test another port. Both scripts use separate disposable demo sessions and do not contact external services.

## Limits

The live Supabase connection, schema, confirmed account, and owner record import are verified; cross-device synchronization was not exercised. Original local workspace files remain intact. Gemini organization, Telegram delivery, Google OAuth/Calendar/Gmail, and Cloudflare scheduling were not exercised against live accounts. Voice needs separately prepared Python/model assets on its app host and is not a browser-only or Node-only serverless feature. Installation metadata is included; offline synchronization and background microphone listening are not implemented. The earlier focus/Desk UI is superseded; historical integration APIs remain for compatibility. Hardware firmware and physical devices are outside this delivery.

The colour update was inspected in the current browser and a screenshot saved beside the source archive. Screenshots, personal records, installed voice assets, and credentials are excluded from the public Git repository.
