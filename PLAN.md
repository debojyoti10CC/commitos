# Capture and organize execution plan

Acceptance: a user types arbitrary information, or reviews a speech transcript and submits it; it is saved, classified and filed into related collections/person/date views automatically, remains after reload, and shows a deadline percentage only when a date exists. No focus meter or Start/Done flow is required. Speech pauses must never silently file incomplete fragments.

1. Preserve the existing workspace and add general records through an additive local/PostgreSQL transition.
2. Classify mixed captures into tasks, notes, ideas, events, and references. Retain wording and save ambiguous dates with an explanation.
3. Add atomic capture, idempotent retry, owner-scoped reads/corrections, and optional validated AI enrichment with local fallback.
4. Make capture and accumulated records the main responsive interface. Replace the focus routes and command actions.
5. Use black/white components and segmented time-left bars. Group and count collections and people automatically.
6. Prove persistence, ownership, percentages, parser failure handling, migrations, production build, and desktop/phone interaction.

The website and installable standalone view share the same code and backend. Local demo uses a per-browser identity; authenticated Supabase is the cross-device path. No existing data is deleted, and no deployment or physical hardware work is performed.
