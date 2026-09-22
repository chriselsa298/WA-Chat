-- ============================================================
-- 043_coexistence
--
-- WhatsApp Coexistence: the business number stays live in the
-- WhatsApp Business app while the Cloud API runs alongside it. Meta
-- then posts three extra webhook fields that this schema has no place
-- for yet:
--
--   smb_message_echoes  — every message the team sends FROM THE PHONE.
--                         Outbound, but it never went through our send
--                         path, so nothing in `messages` records it.
--   history             — the chat log that existed before onboarding,
--                         delivered in chunks over phases 0/1/2.
--   smb_app_state_sync  — contacts added / edited / removed in the app.
--
-- Two changes:
--
--   1. `messages.source` — where a row came from. 'crm' (our composer,
--      the public API, automations), 'business_app' (an echo), or
--      'history' (the pre-onboarding import). Defaults to 'crm' so
--      every existing row and every existing INSERT keeps its current
--      meaning without a code change. The inbox needs this to explain
--      to an agent why a message they never typed is in the thread,
--      and the history import needs it to stay distinguishable from
--      live traffic.
--
--   2. `whatsapp_config.coexistence_*` / `history_sync_*` — the mode
--      flag plus the import's progress. Meta sends `phase` (0 = day
--      0-1, 1 = day 1-90, 2 = day 90-180), `chunk_order` and
--      `progress` (0-100) on every history chunk; persisting the last
--      one is what lets the UI say "Verlauf wird importiert, 60 %"
--      instead of showing a half-filled inbox with no explanation.
--
-- NOT changed: idempotency. Migration 037 already put a unique index
-- on (conversation_id, message_id), which is exactly the key echoes
-- and history need — Meta re-delivers both, and the existing
-- ON CONFLICT DO NOTHING upsert path handles the replay. No second
-- index is required.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'crm';

-- Separate statement (not inline on ADD COLUMN) so a re-run against a
-- database that already has the column does not error on the
-- constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_source_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_source_check
      CHECK (source IN ('crm', 'business_app', 'history'));
  END IF;
END $$;

-- The inbox filters "hide imported history" per conversation, and the
-- history importer counts what it already wrote. Both are
-- conversation-scoped, so the index leads with conversation_id.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_source
  ON messages (conversation_id, source);

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS coexistence_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS history_sync_phase SMALLINT,
  ADD COLUMN IF NOT EXISTS history_sync_progress SMALLINT,
  ADD COLUMN IF NOT EXISTS history_sync_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS history_sync_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN messages.source IS
  'Origin of the row: crm (sent through this app), business_app (echo of a message sent from the WhatsApp Business app under Coexistence), history (imported pre-onboarding chat log).';

COMMENT ON COLUMN whatsapp_config.history_sync_progress IS
  'Last progress value (0-100) Meta reported on a history webhook chunk. NULL until the first chunk arrives.';
