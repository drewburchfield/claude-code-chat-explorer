/**
 * WorktreeClassifier Unit Tests
 *
 * The cwd convention is the only signal that a session ran inside an isolated
 * agent worktree: the transcript carries no parent linkage. A false positive
 * silently re-attributes a real top-level project to something else, so the
 * negative cases matter as much as the positive ones.
 */

import { describe, it, expect } from 'vitest';
const { classifyAgentWorktree } = require('../../src/analytics/core/WorktreeClassifier');

describe('classifyAgentWorktree()', () => {
  describe('<repo>/.worktrees/<name> (Agent tool isolation)', () => {
    it('attributes the session to the repo that owns the worktree', () => {
      expect(classifyAgentWorktree('/Users/dev/projects/my-app/.worktrees/agent-fix-1'))
        .toEqual({ owningProject: 'my-app' });
    });

    it('classifies a cwd nested below the worktree root', () => {
      expect(classifyAgentWorktree('/Users/dev/projects/my-app/.worktrees/agent-fix-1/src/api'))
        .toEqual({ owningProject: 'my-app' });
    });

    it('handles a repo checked out at a short path', () => {
      expect(classifyAgentWorktree('/work/demo/.worktrees/x'))
        .toEqual({ owningProject: 'demo' });
    });
  });

  describe('<repo>/.claude/worktrees/<name> (EnterWorktree)', () => {
    it('attributes the session to the owning repo', () => {
      expect(classifyAgentWorktree('/Users/dev/projects/my-app/.claude/worktrees/feature-x'))
        .toEqual({ owningProject: 'my-app' });
    });

    it('classifies a cwd nested below the worktree root', () => {
      expect(classifyAgentWorktree('/Users/dev/projects/my-app/.claude/worktrees/feature-x/test/unit'))
        .toEqual({ owningProject: 'my-app' });
    });
  });

  describe('.cyrus/worktrees/<issue> (Cyrus Linear runner)', () => {
    it('groups every Cyrus checkout under a single "cyrus" project', () => {
      // The path carries no repo name, so per-issue folders would otherwise
      // each become their own fake top-level project.
      expect(classifyAgentWorktree('/Users/dev/.cyrus/worktrees/NAS-1467'))
        .toEqual({ owningProject: 'cyrus' });
      expect(classifyAgentWorktree('/Users/dev/.cyrus/worktrees/ENG-42'))
        .toEqual({ owningProject: 'cyrus' });
    });

    it('classifies a cwd nested below the issue root', () => {
      expect(classifyAgentWorktree('/Users/dev/.cyrus/worktrees/NAS-1467/packages/core'))
        .toEqual({ owningProject: 'cyrus' });
    });
  });

  describe('non-worktree cwds', () => {
    it('does not classify a plain repo checkout', () => {
      expect(classifyAgentWorktree('/Users/dev/projects/claude-chats-monitor')).toBeNull();
      expect(classifyAgentWorktree('/work/demo')).toBeNull();
      expect(classifyAgentWorktree('/work/demo/src/analytics')).toBeNull();
    });

    it('does not classify a manually-named sibling checkout', () => {
      // A hand-made clone like `<project>-dev` is a real project of its own.
      expect(classifyAgentWorktree('/Users/x/dev/projects/claude-chats-monitor-dev')).toBeNull();
    });

    it('does not classify a directory that merely contains "worktrees"', () => {
      expect(classifyAgentWorktree('/Users/x/worktrees-collection/thing')).toBeNull();
      expect(classifyAgentWorktree('/Users/x/worktrees/thing')).toBeNull();
      expect(classifyAgentWorktree('/Users/x/my.worktrees-backup/thing')).toBeNull();
    });

    it('does not classify the worktrees container itself, only a checkout inside it', () => {
      expect(classifyAgentWorktree('/work/demo/.worktrees')).toBeNull();
      expect(classifyAgentWorktree('/work/demo/.claude/worktrees')).toBeNull();
    });

    it('returns null for missing or empty input', () => {
      expect(classifyAgentWorktree(null)).toBeNull();
      expect(classifyAgentWorktree(undefined)).toBeNull();
      expect(classifyAgentWorktree('')).toBeNull();
      expect(classifyAgentWorktree(12345)).toBeNull();
    });
  });
});
