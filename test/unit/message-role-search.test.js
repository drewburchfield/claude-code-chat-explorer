/**
 * Per-message role-granular search (message_fts). Verifies that a token
 * present only in a USER message is found when filtering role=user but not
 * role=assistant, and that role-less search still finds it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createTestDatabase, createMockConversation } = require('../helpers/test-db');

describe('searchConversationsByRole', () => {
  let db, cleanup;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDatabase());
    db.upsertConversation(
      createMockConversation({ id: 'c1', project: 'p' }),
      'find ROLETOKEN here\nno match here',
      [
        { seq: 0, role: 'user', tool_name: null, text: 'please find ROLETOKEN here' },
        { seq: 1, role: 'assistant', tool_name: null, text: 'sure, here is the answer' },
        { seq: 2, role: 'tool', tool_name: 'Bash', text: 'TOOLONLYTOKEN in output' },
      ]
    );
  });

  afterEach(async () => { await cleanup(); });

  it('finds a token that is only in a user message when role=user', () => {
    const r = db.searchConversationsByRole('ROLETOKEN', { role: 'user' });
    expect(r.length).toBe(1);
    expect(r[0].id).toBe('c1');
    expect(r[0].matchedRole).toBe('user');
  });

  it('does NOT find that user-only token when role=assistant', () => {
    const r = db.searchConversationsByRole('ROLETOKEN', { role: 'assistant' });
    expect(r.length).toBe(0);
  });

  it('finds it with no role filter', () => {
    const r = db.searchConversationsByRole('ROLETOKEN', {});
    expect(r.length).toBe(1);
  });

  it('filters by tool_name', () => {
    const r = db.searchConversationsByRole('TOOLONLYTOKEN', { tool: 'Bash' });
    expect(r.length).toBe(1);
    expect(r[0].matchedRole).toBe('tool');
    const none = db.searchConversationsByRole('TOOLONLYTOKEN', { tool: 'Read' });
    expect(none.length).toBe(0);
  });

  it('returns one row per conversation (best message), with a snippet', () => {
    const r = db.searchConversationsByRole('ROLETOKEN', {});
    expect(r.length).toBe(1);
    expect(r[0].snippet).toContain('ROLETOKEN');
  });

  it('removeConversation cleans up message_fts (no orphans)', () => {
    expect(db.searchConversationsByRole('ROLETOKEN', {}).length).toBe(1);
    db.removeConversation('c1');
    expect(db.searchConversationsByRole('ROLETOKEN', {}).length).toBe(0);
  });
});
