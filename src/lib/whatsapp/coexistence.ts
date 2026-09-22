/**
 * WhatsApp Coexistence webhook handling.
 *
 * Under Coexistence the business number stays usable in the WhatsApp
 * Business app while the Cloud API runs on the same number. Meta then
 * posts three fields the normal `messages` branch knows nothing about:
 *
 *   `smb_message_echoes`  every message the team sends FROM THE PHONE.
 *                         Outbound, but it never passed through our
 *                         send path, so without this the inbox shows
 *                         half a conversation — the customer's side
 *                         only — and an agent answers something a
 *                         colleague already handled.
 *   `history`             the chat log from before onboarding, pushed
 *                         in chunks across three phases (day 0-1,
 *                         1-90, 90-180) with a progress percentage.
 *   `smb_app_state_sync`  contacts added / edited / removed in the app.
 *
 * Docs:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
 *
 * The contact / conversation / content helpers live in the webhook
 * route and are injected rather than imported: they close over the
 * route's admin client and its race handling, and duplicating that
 * here would be two implementations of "same customer" drifting apart
 * (issue #212's whole point). Injection also lets this module be unit
 * tested without a database.
 */

import { normalizePhone } from './phone-utils';
import type { WaIdentity } from './wa-identity';

/** The three fields Meta sends only for a Coexistence number. */
const COEXISTENCE_FIELDS = new Set([
  'smb_message_echoes',
  'history',
  'smb_app_state_sync',
]);

export function isCoexistenceField(field: string): boolean {
  return COEXISTENCE_FIELDS.has(field);
}

// ============================================================
// Payload shapes
// ============================================================

/**
 * A message inside an echo or a history thread. Same envelope as an
 * inbound message, plus `to` (echoes are outbound, so the customer is
 * the recipient) and `history_context` on history rows.
 */
export interface CoexistenceMessage {
  id: string;
  from?: string;
  to?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  /**
   * History only. `from_me` is the single source of truth for
   * direction — a history thread carries both sides, and `from` is the
   * business number on the rows the business sent.
   */
  history_context?: { from_me?: boolean; status?: string };
  errors?: Array<{ code?: number; title?: string }>;
  [key: string]: unknown;
}

export interface HistoryThread {
  /** The customer's phone number. */
  id?: string;
  messages?: CoexistenceMessage[];
}

export interface HistoryChunk {
  metadata?: {
    phase?: number | string;
    chunk_order?: number | string;
    progress?: number | string;
  };
  threads?: HistoryThread[];
}

export interface StateSyncEntry {
  type?: string;
  action?: string;
  contact?: { full_name?: string; phone_number?: string };
  metadata?: { timestamp?: string };
}

export interface CoexistenceValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  message_echoes?: CoexistenceMessage[];
  history?: HistoryChunk[];
  state_sync?: StateSyncEntry[];
}

// ============================================================
// Injected collaborators
// ============================================================

export interface CoexistenceContactRow {
  id: string;
  name?: string | null;
  phone?: string | null;
}

export interface CoexistenceConversationRow {
  id: string;
  last_message_at?: string | null;
}

export interface ParsedContent {
  contentText: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  interactiveReplyId: string | null;
}

export interface CoexistenceDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  findOrCreateContact(
    accountId: string,
    configOwnerUserId: string,
    identity: WaIdentity
  ): Promise<{ contact: CoexistenceContactRow; wasCreated: boolean } | null>;
  findOrCreateConversation(
    accountId: string,
    configOwnerUserId: string,
    contactId: string
  ): Promise<{
    conversation: CoexistenceConversationRow;
    created: boolean;
  } | null>;
  parseContent(
    message: CoexistenceMessage,
    accessToken: string,
    mirror: { accountId: string } | null
  ): Promise<ParsedContent>;
}

export interface CoexistenceContext {
  accountId: string;
  configOwnerUserId: string;
  /** `whatsapp_config.id` — history progress is written back onto it. */
  configId: string;
  accessToken: string;
  mirrorMedia: boolean;
}

// ============================================================
// Shared helpers
// ============================================================

/**
 * `messages.content_type` CHECK (migration 001, widened in 010).
 * Anything Meta sends that isn't on the list has to be mapped or the
 * INSERT fails the constraint and the message is lost.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
]);

export function mapContentType(type: string | undefined): string {
  if (!type) return 'text';
  if (ALLOWED_CONTENT_TYPES.has(type)) return type;
  if (type === 'sticker') return 'image';
  if (type === 'button') return 'interactive';
  return 'text';
}

/** `messages.status` CHECK (migration 001). */
function mapHistoryStatus(status: string | undefined, fromMe: boolean): string {
  switch (status) {
    case 'read':
    case 'played':
      return 'read';
    case 'delivered':
      return 'delivered';
    case 'sent':
      return 'sent';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      // No status on the row: an outbound message at least left the
      // phone, and an inbound one by definition reached us.
      return fromMe ? 'sent' : 'delivered';
  }
}

/** Meta sends seconds; Postgres wants an ISO timestamp. */
function timestampToIso(timestamp: string | undefined): string {
  const seconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(seconds) || seconds <= 0) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

function phoneIdentity(phone: string, name?: string): WaIdentity {
  return {
    phone: normalizePhone(phone),
    waUserId: null,
    waParentUserId: null,
    waUsername: null,
    name: name?.trim() ?? '',
  };
}

// ============================================================
// Entry point
// ============================================================

export async function handleCoexistenceChange(
  change: { field: string; value: CoexistenceValue },
  ctx: CoexistenceContext,
  deps: CoexistenceDeps
): Promise<void> {
  switch (change.field) {
    case 'smb_message_echoes':
      await handleMessageEchoes(change.value, ctx, deps);
      return;
    case 'history':
      await handleHistorySync(change.value, ctx, deps);
      return;
    case 'smb_app_state_sync':
      await handleAppStateSync(change.value, ctx, deps);
      return;
    default:
      console.warn('[coexistence] unhandled field:', change.field);
  }
}

// ============================================================
// smb_message_echoes
// ============================================================

/**
 * Messages the team sent from the WhatsApp Business app.
 *
 * Stored as `sender_type: 'agent'` with `source: 'business_app'` so
 * the inbox can show that a colleague answered from their phone. The
 * upsert is idempotent on (conversation_id, message_id) — the same
 * key the inbound path uses (migration 037) — which also covers the
 * case where Meta echoes a message our own send path already wrote.
 */
async function handleMessageEchoes(
  value: CoexistenceValue,
  ctx: CoexistenceContext,
  deps: CoexistenceDeps
): Promise<void> {
  const echoes = value.message_echoes ?? [];

  for (const echo of echoes) {
    // On an echo the business is `from` and the customer is `to`.
    const customerPhone = normalizePhone(echo.to ?? '');
    if (!customerPhone) {
      console.error(
        '[coexistence] echo without a recipient phone; skipping:',
        echo.id
      );
      continue;
    }

    const contactOutcome = await deps.findOrCreateContact(
      ctx.accountId,
      ctx.configOwnerUserId,
      phoneIdentity(customerPhone)
    );
    if (!contactOutcome) continue;

    const convResult = await deps.findOrCreateConversation(
      ctx.accountId,
      ctx.configOwnerUserId,
      contactOutcome.contact.id
    );
    if (!convResult) continue;

    const { contentText, mediaUrl, mediaType } = await deps.parseContent(
      echo,
      ctx.accessToken,
      ctx.mirrorMedia ? { accountId: ctx.accountId } : null
    );

    const inserted = await insertCoexistenceMessage(deps.db, {
      conversationId: convResult.conversation.id,
      senderType: 'agent',
      contentType: mapContentType(echo.type),
      contentText,
      mediaUrl,
      mediaType,
      messageId: echo.id,
      status: 'sent',
      createdAt: timestampToIso(echo.timestamp),
      source: 'business_app',
    });

    // Replay, or a message our own send path already stored. Either
    // way the downstream side effects have run once already.
    if (!inserted) continue;

    // Guarded, not a blind write: Meta does not promise ordering, and
    // a re-delivered older echo must not drag the inbox summary back
    // behind a newer message.
    await advanceConversationSummary(deps.db, convResult.conversation, {
      text: contentText || `[${echo.type ?? 'text'}]`,
      at: timestampToIso(echo.timestamp),
    });

    // A human answering from their phone is the same "yield, a person
    // is here" signal as an agent replying in the composer, so it
    // pauses any running flow (mirrors send-message.ts). Without this
    // the bot keeps talking over a colleague who already replied —
    // the failure mode Coexistence makes most likely.
    await pauseActiveFlowRuns(
      deps.db,
      ctx.accountId,
      contactOutcome.contact.id
    );
  }
}

// ============================================================
// history
// ============================================================

/**
 * The pre-onboarding chat log, in chunks.
 *
 * Deliberately inert: no unread bump, no automations, no flows, no AI
 * auto-reply, no public webhook dispatch. These are messages from
 * before the CRM existed — replaying them through the engines would
 * fire a welcome automation at every customer the business has ever
 * talked to. That is the one mistake here that reaches real people.
 */
async function handleHistorySync(
  value: CoexistenceValue,
  ctx: CoexistenceContext,
  deps: CoexistenceDeps
): Promise<void> {
  const chunks = value.history ?? [];

  for (const chunk of chunks) {
    for (const thread of chunk.threads ?? []) {
      const messages = thread.messages ?? [];
      if (messages.length === 0) continue;

      // The thread id is the customer's number. Fall back to the
      // first message's counterparty if Meta ever omits it.
      const fallback = messages[0].history_context?.from_me
        ? messages[0].to
        : messages[0].from;
      const customerPhone = normalizePhone(thread.id ?? fallback ?? '');
      if (!customerPhone) {
        console.error('[coexistence] history thread without a phone; skipping');
        continue;
      }

      const contactOutcome = await deps.findOrCreateContact(
        ctx.accountId,
        ctx.configOwnerUserId,
        phoneIdentity(customerPhone)
      );
      if (!contactOutcome) continue;

      const convResult = await deps.findOrCreateConversation(
        ctx.accountId,
        ctx.configOwnerUserId,
        contactOutcome.contact.id
      );
      if (!convResult) continue;

      let newest: { iso: string; message: CoexistenceMessage } | null = null;

      for (const message of messages) {
        // Meta includes rows it could not render (`errors`) — there is
        // no content to import and the constraint would take the
        // fallback 'text' with a null body.
        if (message.type === 'errors' || message.errors?.length) continue;

        const fromMe = message.history_context?.from_me === true;
        const { contentText, mediaUrl, mediaType } = await deps.parseContent(
          message,
          ctx.accessToken,
          // Historical media is not mirrored: Meta's media ids for a
          // pre-onboarding message are frequently already expired, and
          // a failed download per message would turn a 180-day import
          // into thousands of dead Meta calls.
          null
        );

        const createdAt = timestampToIso(message.timestamp);
        const inserted = await insertCoexistenceMessage(deps.db, {
          conversationId: convResult.conversation.id,
          senderType: fromMe ? 'agent' : 'customer',
          contentType: mapContentType(message.type),
          contentText,
          mediaUrl,
          mediaType,
          messageId: message.id,
          status: mapHistoryStatus(message.history_context?.status, fromMe),
          createdAt,
          source: 'history',
        });

        if (inserted && (!newest || createdAt > newest.iso)) {
          newest = { iso: createdAt, message };
        }
      }

      // A chunk from phase 2 (90-180 days ago) must never overwrite a
      // live message that arrived while the import was running.
      if (newest) {
        await advanceConversationSummary(deps.db, convResult.conversation, {
          text:
            newest.message.text?.body?.trim() ||
            `[${newest.message.type ?? 'text'}]`,
          at: newest.iso,
        });
      }
    }

    await recordHistoryProgress(deps.db, ctx.configId, chunk.metadata);
  }
}

/**
 * Persist Meta's own progress reporting so the UI can explain a
 * partially filled inbox instead of looking broken. `progress` reaching
 * 100 on phase 2 is the end of the import.
 */
async function recordHistoryProgress(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  configId: string,
  metadata: HistoryChunk['metadata']
): Promise<void> {
  if (!metadata) return;

  const phase = Number(metadata.phase);
  const progress = Number(metadata.progress);
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (Number.isFinite(phase)) patch.history_sync_phase = phase;
  if (Number.isFinite(progress)) {
    patch.history_sync_progress = progress;
    if (progress >= 100 && phase === 2) {
      patch.history_sync_completed_at = new Date().toISOString();
    }
  }

  const { error } = await db
    .from('whatsapp_config')
    .update(patch)
    .eq('id', configId);

  if (error) {
    console.error(
      '[coexistence] history progress update failed:',
      error.message
    );
  }
}

// ============================================================
// smb_app_state_sync
// ============================================================

/**
 * Contacts added, edited or removed in the WhatsApp Business app.
 *
 * `remove` does NOT delete the CRM contact. The app's address book and
 * the CRM's contact list are not the same thing: deleting here would
 * cascade the conversation and every message in it (migration 001's
 * ON DELETE CASCADE) because someone tidied their phone. Removals are
 * logged and otherwise ignored; deleting a contact stays a deliberate
 * action in the CRM.
 */
async function handleAppStateSync(
  value: CoexistenceValue,
  ctx: CoexistenceContext,
  deps: CoexistenceDeps
): Promise<void> {
  for (const entry of value.state_sync ?? []) {
    if (entry.type !== 'contact') {
      console.info('[coexistence] ignoring state_sync type:', entry.type);
      continue;
    }

    const phone = normalizePhone(entry.contact?.phone_number ?? '');
    if (!phone) {
      console.error(
        '[coexistence] state_sync contact without a phone; skipping'
      );
      continue;
    }

    if (entry.action === 'remove') {
      console.info(
        '[coexistence] contact removed in the Business app; CRM row kept:',
        phone
      );
      continue;
    }

    const fullName = entry.contact?.full_name?.trim() ?? '';
    const outcome = await deps.findOrCreateContact(
      ctx.accountId,
      ctx.configOwnerUserId,
      phoneIdentity(phone, fullName)
    );
    if (!outcome) continue;

    // Adopt the app's name only when the CRM has nothing better. A
    // name an agent typed in the CRM outranks the one on someone's
    // phone; a row whose "name" is just the number does not.
    const current = outcome.contact.name?.trim() ?? '';
    const isPlaceholder = current === '' || normalizePhone(current) === phone;
    if (fullName && isPlaceholder && fullName !== current) {
      const { error } = await deps.db
        .from('contacts')
        .update({ name: fullName, updated_at: new Date().toISOString() })
        .eq('id', outcome.contact.id);
      if (error) {
        console.error('[coexistence] contact name sync failed:', error.message);
      }
    }
  }
}

// ============================================================
// Shared writes
// ============================================================

interface CoexistenceMessageInsert {
  conversationId: string;
  senderType: 'agent' | 'customer';
  contentType: string;
  contentText: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  messageId: string;
  status: string;
  createdAt: string;
  source: 'business_app' | 'history';
}

/**
 * Returns true only on a genuine first insert. Meta re-delivers both
 * echoes and history chunks, so every caller must gate its side
 * effects on this — same contract as the inbound path (issue #367).
 */
async function insertCoexistenceMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  row: CoexistenceMessageInsert
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: row.conversationId,
        sender_type: row.senderType,
        content_type: row.contentType,
        content_text: row.contentText,
        media_url: row.mediaUrl,
        media_type: row.mediaType,
        message_id: row.messageId,
        status: row.status,
        created_at: row.createdAt,
        source: row.source,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id');

  if (error) {
    console.error('[coexistence] message insert failed:', error.message);
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

/**
 * Move the inbox summary forward, never backward.
 *
 * Unlike the inbound path this is a plain UPDATE rather than the
 * `bump_conversation_on_inbound` RPC: neither an echo nor a history row
 * may touch `unread_count`. An echo is the team's own message, and
 * history is the past — marking either unread would light up the whole
 * inbox the moment Coexistence is switched on.
 */
async function advanceConversationSummary(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  conversation: CoexistenceConversationRow,
  summary: { text: string; at: string }
): Promise<void> {
  const current = conversation.last_message_at;
  if (current && summary.at <= current) return;

  const { error } = await db
    .from('conversations')
    .update({
      last_message_text: summary.text,
      last_message_at: summary.at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);

  if (error) {
    console.error('[coexistence] conversation update failed:', error.message);
  }
}

async function pauseActiveFlowRuns(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  contactId: string
): Promise<void> {
  const { error } = await db
    .from('flow_runs')
    .update({
      status: 'paused_by_agent',
      ended_at: new Date().toISOString(),
      end_reason: 'agent_replied',
    })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active');

  if (error) {
    console.error('[coexistence] flow pause failed:', error.message);
  }
}
