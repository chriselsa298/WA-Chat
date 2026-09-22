import { describe, expect, it, vi } from 'vitest';
import {
  handleCoexistenceChange,
  isCoexistenceField,
  mapContentType,
  type CoexistenceContext,
  type CoexistenceDeps,
  type CoexistenceValue,
} from './coexistence';

// ============================================================
// Test doubles
//
// The db stub records every write and answers the exact chains this
// module uses. Anything it doesn't know about throws, so an
// unintended table write fails the test loudly rather than silently
// resolving to undefined:
//   messages:        .upsert().select()  -> { data, error }
//   conversations:   .update().eq()      -> { error }
//   whatsapp_config: .update().eq()      -> { error }
//   contacts:        .update().eq()      -> { error }
//   flow_runs:       .update().eq().eq().eq() -> { error }
// ============================================================

interface Write {
  table: string;
  payload: Record<string, unknown>;
  filters: { column: string; value: unknown }[];
}

function makeDb(opts: { insertedIds?: (string | null)[] } = {}) {
  const writes: Write[] = [];
  // Each messages.upsert pops the next outcome: a row id means a
  // genuine first insert, null means ON CONFLICT DO NOTHING swallowed
  // a replay.
  const inserted = [...(opts.insertedIds ?? [])];

  const db = {
    from(table: string) {
      if (table === 'messages') {
        return {
          upsert(payload: Record<string, unknown>) {
            const entry: Write = { table, payload, filters: [] };
            writes.push(entry);
            return {
              select() {
                const next = inserted.length > 0 ? inserted.shift() : 'msg-1';
                return Promise.resolve({
                  data: next ? [{ id: next }] : [],
                  error: null,
                });
              },
            };
          },
        };
      }
      if (
        table === 'conversations' ||
        table === 'whatsapp_config' ||
        table === 'contacts' ||
        table === 'flow_runs'
      ) {
        return {
          update(payload: Record<string, unknown>) {
            const entry: Write = { table, payload, filters: [] };
            writes.push(entry);
            const chain = {
              eq(column: string, value: unknown) {
                entry.filters.push({ column, value });
                // Terminal on await, chainable for the multi-eq
                // flow_runs filter.
                return Object.assign(Promise.resolve({ error: null }), chain);
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };

  return { db, writes, of: (t: string) => writes.filter((w) => w.table === t) };
}

const CTX: CoexistenceContext = {
  accountId: 'acc-1',
  configOwnerUserId: 'user-1',
  configId: 'cfg-1',
  accessToken: 'token',
  mirrorMedia: true,
};

function makeDeps(
  db: unknown,
  overrides: Partial<CoexistenceDeps> = {}
): CoexistenceDeps {
  return {
    db,
    findOrCreateContact: vi.fn(async () => ({
      contact: { id: 'contact-1', name: '', phone: '4915112345678' },
      wasCreated: false,
    })),
    findOrCreateConversation: vi.fn(async () => ({
      conversation: { id: 'conv-1', last_message_at: null },
      created: false,
    })),
    parseContent: vi.fn(async (message) => ({
      contentText: (message.text?.body as string) ?? null,
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    })),
    ...overrides,
  } as CoexistenceDeps;
}

describe('isCoexistenceField', () => {
  it('matches the three Coexistence fields and nothing else', () => {
    expect(isCoexistenceField('smb_message_echoes')).toBe(true);
    expect(isCoexistenceField('history')).toBe(true);
    expect(isCoexistenceField('smb_app_state_sync')).toBe(true);
    expect(isCoexistenceField('messages')).toBe(false);
    expect(isCoexistenceField('message_template_status_update')).toBe(false);
  });
});

describe('mapContentType', () => {
  it('passes through allowed types and maps the rest', () => {
    expect(mapContentType('text')).toBe('text');
    expect(mapContentType('image')).toBe('image');
    expect(mapContentType('sticker')).toBe('image');
    expect(mapContentType('button')).toBe('interactive');
    expect(mapContentType('unknown_future_type')).toBe('text');
    expect(mapContentType(undefined)).toBe('text');
  });
});

describe('smb_message_echoes', () => {
  const echoValue: CoexistenceValue = {
    metadata: { phone_number_id: 'pn-1' },
    message_echoes: [
      {
        from: '4930000000',
        to: '+49 151 12345678',
        id: 'wamid.ECHO1',
        timestamp: '1758540000',
        type: 'text',
        text: { body: 'Zimmer ab Montag frei' },
      },
    ],
  };

  it('stores a phone-sent message as an outbound row from the app', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      { field: 'smb_message_echoes', value: echoValue },
      CTX,
      makeDeps(db)
    );

    const [msg] = of('messages');
    expect(msg.payload).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      content_type: 'text',
      content_text: 'Zimmer ab Montag frei',
      message_id: 'wamid.ECHO1',
      status: 'sent',
      source: 'business_app',
    });
    expect(msg.payload.created_at).toBe(
      new Date(1758540000 * 1000).toISOString()
    );
  });

  it('resolves the contact from `to`, not from the business number', async () => {
    const { db } = makeDb();
    const deps = makeDeps(db);
    await handleCoexistenceChange(
      { field: 'smb_message_echoes', value: echoValue },
      CTX,
      deps
    );

    expect(deps.findOrCreateContact).toHaveBeenCalledWith(
      'acc-1',
      'user-1',
      expect.objectContaining({ phone: '4915112345678' })
    );
  });

  it('updates the conversation summary and pauses a running flow', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      { field: 'smb_message_echoes', value: echoValue },
      CTX,
      makeDeps(db)
    );

    expect(of('conversations')[0].payload).toMatchObject({
      last_message_text: 'Zimmer ab Montag frei',
    });
    const [flow] = of('flow_runs');
    expect(flow.payload).toMatchObject({
      status: 'paused_by_agent',
      end_reason: 'agent_replied',
    });
    expect(flow.filters).toEqual([
      { column: 'account_id', value: 'acc-1' },
      { column: 'contact_id', value: 'contact-1' },
      { column: 'status', value: 'active' },
    ]);
  });

  it('does nothing further when the echo is a replay', async () => {
    // ON CONFLICT DO NOTHING -> no returned row.
    const { db, of } = makeDb({ insertedIds: [null] });
    await handleCoexistenceChange(
      { field: 'smb_message_echoes', value: echoValue },
      CTX,
      makeDeps(db)
    );

    expect(of('messages')).toHaveLength(1);
    expect(of('conversations')).toHaveLength(0);
    expect(of('flow_runs')).toHaveLength(0);
  });

  it('does not drag the summary back when an older echo is re-delivered', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      { field: 'smb_message_echoes', value: echoValue },
      CTX,
      makeDeps(db, {
        findOrCreateConversation: vi.fn(async () => ({
          conversation: {
            id: 'conv-1',
            // A newer message already landed in this thread.
            last_message_at: new Date('2026-09-22T12:00:00Z').toISOString(),
          },
          created: false,
        })),
      })
    );

    // The message itself is still stored; only the summary is held back.
    expect(of('messages')).toHaveLength(1);
    expect(of('conversations')).toHaveLength(0);
  });

  it('skips an echo with no recipient rather than inventing a contact', async () => {
    const { db, of } = makeDb();
    const deps = makeDeps(db);
    await handleCoexistenceChange(
      {
        field: 'smb_message_echoes',
        value: { message_echoes: [{ id: 'wamid.NOTO', type: 'text' }] },
      },
      CTX,
      deps
    );

    expect(deps.findOrCreateContact).not.toHaveBeenCalled();
    expect(of('messages')).toHaveLength(0);
  });
});

describe('history', () => {
  const historyValue: CoexistenceValue = {
    metadata: { phone_number_id: 'pn-1' },
    history: [
      {
        metadata: { phase: 0, chunk_order: 1, progress: 40 },
        threads: [
          {
            id: '4915112345678',
            messages: [
              {
                id: 'wamid.IN1',
                from: '4915112345678',
                timestamp: '1758000000',
                type: 'text',
                text: { body: 'Habt ihr was in Koblenz?' },
                history_context: { from_me: false, status: 'read' },
              },
              {
                id: 'wamid.OUT1',
                from: '4930000000',
                to: '4915112345678',
                timestamp: '1758000600',
                type: 'text',
                text: { body: 'Ja, ab 1.10.' },
                history_context: { from_me: true, status: 'read' },
              },
              {
                id: 'wamid.ERR1',
                timestamp: '1758000900',
                type: 'errors',
                errors: [{ code: 131051, title: 'Unsupported message type' }],
              },
            ],
          },
        ],
      },
    ],
  };

  it('imports both directions with the history source', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      { field: 'history', value: historyValue },
      CTX,
      makeDeps(db)
    );

    const messages = of('messages');
    expect(messages).toHaveLength(2);
    expect(messages[0].payload).toMatchObject({
      sender_type: 'customer',
      message_id: 'wamid.IN1',
      status: 'read',
      source: 'history',
    });
    expect(messages[1].payload).toMatchObject({
      sender_type: 'agent',
      message_id: 'wamid.OUT1',
      status: 'read',
      source: 'history',
    });
  });

  it('never runs the live-traffic side effects on imported messages', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      { field: 'history', value: historyValue },
      CTX,
      makeDeps(db)
    );

    // A flow pause here would mean the engines saw these rows; the
    // real risk is an automation firing at every past customer.
    expect(of('flow_runs')).toHaveLength(0);
  });

  it('does not download media for historical messages', async () => {
    const { db } = makeDb();
    const deps = makeDeps(db);
    await handleCoexistenceChange(
      { field: 'history', value: historyValue },
      CTX,
      deps
    );

    for (const call of (deps.parseContent as ReturnType<typeof vi.fn>).mock
      .calls) {
      expect(call[2]).toBeNull();
    }
  });

  it('moves the conversation summary forward but never backward', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      { field: 'history', value: historyValue },
      CTX,
      makeDeps(db)
    );
    expect(of('conversations')[0].payload).toMatchObject({
      last_message_text: 'Ja, ab 1.10.',
    });

    // Same import against a conversation whose live traffic is newer.
    const fresh = makeDb();
    await handleCoexistenceChange(
      { field: 'history', value: historyValue },
      CTX,
      makeDeps(fresh.db, {
        findOrCreateConversation: vi.fn(async () => ({
          conversation: {
            id: 'conv-1',
            last_message_at: new Date('2026-09-22T10:00:00Z').toISOString(),
          },
          created: false,
        })),
      })
    );
    expect(fresh.of('conversations')).toHaveLength(0);
  });

  it('records Metas progress and closes the import on phase 2 at 100', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      { field: 'history', value: historyValue },
      CTX,
      makeDeps(db)
    );
    const mid = of('whatsapp_config')[0];
    expect(mid.payload).toMatchObject({
      history_sync_phase: 0,
      history_sync_progress: 40,
    });
    expect(mid.payload.history_sync_completed_at).toBeUndefined();
    expect(mid.filters).toEqual([{ column: 'id', value: 'cfg-1' }]);

    const done = makeDb();
    await handleCoexistenceChange(
      {
        field: 'history',
        value: {
          history: [
            {
              metadata: { phase: 2, chunk_order: 9, progress: 100 },
              threads: [],
            },
          ],
        },
      },
      CTX,
      makeDeps(done.db)
    );
    expect(
      done.of('whatsapp_config')[0].payload.history_sync_completed_at
    ).toEqual(expect.any(String));
  });
});

describe('smb_app_state_sync', () => {
  it('adopts the app contact name when the CRM row has only a number', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      {
        field: 'smb_app_state_sync',
        value: {
          state_sync: [
            {
              type: 'contact',
              action: 'add',
              contact: {
                full_name: 'Baustelle Koblenz GmbH',
                phone_number: '4915112345678',
              },
              metadata: { timestamp: '1758540000' },
            },
          ],
        },
      },
      CTX,
      makeDeps(db)
    );

    expect(of('contacts')[0].payload).toMatchObject({
      name: 'Baustelle Koblenz GmbH',
    });
  });

  it('keeps a name an agent already typed in the CRM', async () => {
    const { db, of } = makeDb();
    await handleCoexistenceChange(
      {
        field: 'smb_app_state_sync',
        value: {
          state_sync: [
            {
              type: 'contact',
              action: 'add',
              contact: {
                full_name: 'Neuer Name',
                phone_number: '4915112345678',
              },
            },
          ],
        },
      },
      CTX,
      makeDeps(db, {
        findOrCreateContact: vi.fn(async () => ({
          contact: {
            id: 'contact-1',
            name: 'Müller Bau, Einkauf',
            phone: '4915112345678',
          },
          wasCreated: false,
        })),
      })
    );

    expect(of('contacts')).toHaveLength(0);
  });

  it('never deletes a CRM contact when one is removed on the phone', async () => {
    const { db, writes } = makeDb();
    await handleCoexistenceChange(
      {
        field: 'smb_app_state_sync',
        value: {
          state_sync: [
            {
              type: 'contact',
              action: 'remove',
              contact: { phone_number: '4915112345678' },
            },
          ],
        },
      },
      CTX,
      makeDeps(db)
    );

    expect(writes).toHaveLength(0);
  });
});
