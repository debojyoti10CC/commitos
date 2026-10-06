# CommitOS

Tell it anything. It saves the record, files related information together, and shows the time left until a deadline.

The current application is a responsive website with standalone installation metadata for desktop and phone. The main flow is capture → saved records → automatic collections. There is no focus session or Start/Done workflow in the interface.

The interface uses a compact 1990s desktop style: beveled panels, striped title bars, and simple native controls, with restrained teal, purple, and amber accents. Navigation contains Records, Dates, Collections, People, and Settings. Settings contains the working timezone preference and, for authenticated accounts, sign out. Local mode opens existing records directly; account forms appear when Supabase account storage is configured.

## Run locally

Use Node.js 24 or later:

```bash
npm ci
# Copy .env.example to .env.local; DEMO_MODE=true works without external accounts.
npm run dev
```

Open http://127.0.0.1:3000. Windows can use `npm.cmd` if PowerShell blocks the npm shim. The existing local demo is kept in private `.data/` files. Each browser identity has its own saved workspace; use authenticated production mode for the same account on multiple devices.

Try a single capture containing several lines:

```text
HydraDB: Send the onboarding video tomorrow at 9 PM
Idea for HydraDB: simplify signup
Rohan prefers email updates.
Save https://example.com/guide for HydraDB
```

Submitting the text saves the records immediately. You do not have to pick a type, collection, or date before saving. Conversational requests such as “Can you remind me to send Mira the update tomorrow evening?” are interpreted into brief action headings, associated people/collections, and dates. Separate action clauses are interpreted separately so one request's date does not replace another's. Original wording is retained; uncertain times remain unresolved rather than becoming invented deadlines.

## Voice capture

Voice uses local [faster-whisper](https://github.com/SYSTRAN/faster-whisper) with the multilingual small model, replacing browser SpeechRecognition. On Windows with Python 3.12 installed, prepare it once from the app directory:

```powershell
./scripts/setup-voice.ps1
```

Setup downloads about 486 MB of model files and installs a private Python environment under `.voice/`. Inference then runs locally on CPU without an API key or speech-service account. Start the website normally, choose English, and click **Voice**. Speak naturally, then click **Stop and save**. The app transcribes the recording, creates the records, and saves them automatically. Pauses never submit. A recording that reaches the two-minute limit becomes an editable draft requiring Save; microphone errors or silence never save a record. Failed transcription keeps audio in the current page for Retry voice; failed record saves keep the transcript and replay-safe request ID. Closing the page discards unsaved audio.

Known collection/person names help recognition. Audio goes only to this app server's local Python process and is neither written to disk nor stored in Supabase; the resulting record text is stored. English, Hindi, and automatic language detection are available. Recognition can still miss names or noisy speech; use Edit on a saved record to correct it. Text capture remains available when microphone access is unavailable or denied.

Local voice needs a host that can run Python and hold the model. `.voice/` is excluded from Git, source archives, and Next deployment traces, so prepare the runtime separately on each host. For a Linux host, create `.voice/venv`, install `scripts/voice-requirements.txt`, and download `Systran/faster-whisper-small` into `.voice/model`; optional `VOICE_PYTHON`/`VOICE_MODEL_DIR` override these paths. A Node-only serverless deployment does not supply this runtime. Microphone access on a phone requires a reachable HTTPS app origin.

Cards use a brief heading, with dates and countdowns displayed separately. For example, “IIT submission assignment by 10th October 12 a.m. and I need to get an update” becomes **Submit IIT assignment**. The complete statement is preserved in the closed **Original text** section and remains searchable.

## How records work

- Tasks, notes, ideas, events, and references are classified automatically.
- Named projects and people associate related captures. Otherwise, simple topic collections such as Notes, Work, Study, Personal, Ideas, or Links provide a home.
- Bullets, lines, and clear separate intents can become several records from one capture.
- Original captured wording stays available under each card's details. Search spans titles, content, topics, collections, and people.
- Collections and person indexes accumulate counts automatically. The Dates view orders dated records by deadline.
- Ambiguous dates are saved with a visible explanation. Unknown times stay unknown; a note is never assigned a fake deadline.
- Correct a title, type, collection, or deadline after saving if the interpretation missed something.
- A request UUID makes retries idempotent. Failed saves keep the draft; they do not claim the data was saved.

Older commitments remain visible as preserved records. Their original data, sessions, and history remain in storage for compatibility. The former `/desk` and `/review` entry points now lead to the main capture app.

## Deadline percentages

The bar measures time left, using the window from the record's creation to its deadline:

```text
percentage remaining = clamp((deadline − now) / (deadline − created_at) × 100, 0, 100)
```

At capture it is 100%; at the deadline it is 0%. A passed deadline displays overdue time. Records without dates have no countdown bar. Estimated task effort and focus sessions are not used in this percentage. The display updates while the page is open and uses your saved timezone for date labels.

## Storage, accounts, and deployment

Local demo mode is intended for a trusted local machine and uses signed browser identities with atomic, locked file storage. It does not implement password authentication and should not be deployed to an ephemeral/serverless filesystem.

For a shared account on desktop and phone:

1. Create a Supabase project and apply every SQL migration in `supabase/migrations/` in filename order, or link it with the Supabase CLI and run `supabase db push`.
2. Set `DEMO_MODE=false`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY`.
3. Set stable `SESSION_SECRET` and `ENCRYPTION_KEY` values and your HTTPS `APP_URL`.
4. Add the deployed origin and auth callbacks to Supabase's allowed URLs. Use `npm run build` as the hosting build command so deployment traces are checked for private data.
5. Sign in to the same account on both devices. Capture → reload → search on each device verifies shared persistence.

The records migration is additive. Old local state initializes a records array without removing older data. The versioned PostgreSQL save wraps the existing transaction, preserves records omitted by older clients, and enforces owner-scoped reads and service-only writes. Do not rotate encryption keys without migrating or reconnecting stored credentials.

The local server is now configured for the live `commitos` Supabase project. Both migrations were applied together through the SQL Editor on 6 October 2026. All 16 application tables have RLS enabled; live checks confirmed the server can load state while anonymous reads and RPC access are denied. Two earlier captures were imported into the signed-in account and verified by reload; local source bytes remained unchanged and a repeated import made no additional save. The connection is stored only in private `.env.local`, which is excluded from Git and the source archive. Dashboard access does not create an application account: register in CommitOS, confirm the email, and sign in.

To preserve captures from one local workspace in a verified application account, first review a dry run:

```bash
npx tsx scripts/import-local-records.ts --source-owner LOCAL_UUID --target-user AUTH_USER_UUID
```

Add `--apply` after reviewing its counts. The importer verifies the target through Supabase Auth, imports captured records and their referenced associations, skips legacy sample rows, rejects conflicting IDs, and leaves the local source untouched. It never combines unrelated browser workspaces. A repeated import makes no additional save. Use the same selected source and account when retrying.

On a supported browser, install the website through the browser's Install/Add to Home Screen option. The app includes a manifest, icons, and standalone display metadata. Offline CRUD and background voice listening are not implemented.

## Optional AI organization

Set server-only `GEMINI_API_KEY` and optionally `GEMINI_MODEL`. Demo mode uses local organization. A configured production server can enrich classification and grouping with [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output).

Output is schema-validated and must account for every source chunk. The captured wording comes from local input, never from a generated rewrite. Timeouts, unavailable models, or invalid results leave capture usable with local classification and a warning. The API key stays on the server. Local classification is heuristic; unfamiliar phrasing may need a correction after save. Live Gemini enrichment and cross-device application synchronization have not been verified; the live Supabase server connection, account import, and access controls have been checked.

## API

Browser endpoints authenticate the user, validate JSON and mutation origins, and enforce ownership. Reads use private/no-store caching.

```text
GET    /api/state
GET    /api/records
POST   /api/records       {text, source?: "text" | "voice", request_id?: UUID}
PATCH  /api/records/:id   {title?, content?, kind?, collection?, deadline?, tags?, status?}
DELETE /api/records/:id   # soft archive
GET    /api/transcribe   # authenticated local voice readiness
POST   /api/transcribe?language=en|hi|auto  # private audio body; transcript JSON
```

POST returns the updated workspace and newly saved records. Each record stores its kind, collection, topics, people, optional deadline, creation time, source, and interpretation warnings. Archived captures remain deduplicated. The older commitment, notification, and integration APIs remain available for stored-data compatibility; they are not the primary interface.

## Architecture

```text
components/capture.tsx          automatic text/voice capture
components/records-view.tsx     unified feed, filters, collections, countdowns, corrections
lib/records/types.ts           general record contract
lib/records/organizer.ts        portable local classification, grouping, time percentages
lib/records/provider.ts         optional validated Gemini enrichment
lib/records/service.ts          atomic capture, replay protection, corrections
lib/records/voice-server.ts     bounded private audio and local Python invocation
scripts/transcribe-audio.py     offline CPU Whisper transcription
app/api/records/                authenticated record API
lib/db/                        durable local/Supabase persistence
supabase/migrations/           additive schema, RLS, versioned transactions
```

## Environment reference

| Variable                                    | Purpose                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `DEMO_MODE`                                 | `true`: local signed demo. `false`: fail-closed production auth/database.               |
| `APP_URL`                                   | Trusted app origin for links, CSRF validation and callbacks.                            |
| `APP_TIMEZONE`                              | Initial timezone; user settings subsequently control time calculations.                 |
| `DEMO_DATA_DIR`                             | Optional writable local demo data directory.                                            |
| `SESSION_SECRET`                            | Stable server HMAC secret, at least 32 characters. Demo can generate its own local key. |
| `NEXT_PUBLIC_SUPABASE_URL`                  | Supabase project API URL.                                                               |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`             | Public Supabase publishable key (legacy anon keys also work).                            |
| `SUPABASE_SERVICE_ROLE_KEY`                 | Server-only secret key (legacy service_role keys also work).                            |
| `GEMINI_API_KEY` / `GEMINI_MODEL`           | Optional server-side parser credentials/model.                                          |
| `VOICE_PYTHON` / `VOICE_MODEL_DIR`         | Optional server-only local voice runtime/model paths.                                   |
| `TELEGRAM_BOT_TOKEN`                        | Server-only bot credential.                                                             |
| `TELEGRAM_BOT_USERNAME`                     | Public bot username for pairing links.                                                  |
| `TELEGRAM_WEBHOOK_SECRET`                   | Secret checked against Telegram's webhook header.                                       |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth web client credentials.                                                           |
| `GOOGLE_REDIRECT_URI`                       | Exact registered callback URL.                                                          |
| `ENCRYPTION_KEY`                            | 32 random bytes encoded as base64, AES-GCM credential encryption.                       |
| `CRON_SECRET`                               | Shared app/worker bearer credential.                                                    |

Generate keys with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Use distinct values for encryption, sessions, cron, and webhook authentication. Never rotate the encryption key without migrating/reconnecting stored credentials.

## Verification

```bash
npm test
npm run typecheck
npm run build
# In another terminal, run the production app on port 3001:
npm run start -- --port 3001
node scripts/test-records-http.mjs
```

See `VERIFICATION.md` for executed checks, browser proof, and live-service limitations. The source archive excludes local user data, secret files, build output, and installed dependencies. Earlier desk hardware research remains in `hardware/DESK-HUB.md` as historical planning; the physical terminal is not part of this capture app.
