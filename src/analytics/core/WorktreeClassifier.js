/**
 * WorktreeClassifier - detect agent sessions that ran in isolated git
 * worktree checkouts.
 *
 * Harnesses that give an agent its own worktree (the Agent tool's
 * isolation mode, Claude Code's EnterWorktree, the Cyrus Linear runner)
 * start the session with a cwd inside a well-known worktree directory.
 * The transcript itself carries no parent linkage (isSidechain is false,
 * parentUuid is null), so the cwd convention is the only reliable signal.
 * Without it, every worktree shows up as its own fake top-level project.
 */

const path = require('path');

const PATTERNS = [
  // <repo>/.worktrees/<name>[/...]: Agent tool / workflow worktree isolation
  { re: /^(.*)\/\.worktrees\/[^/]+(?:\/|$)/, owner: (m) => path.basename(m[1]) },
  // <repo>/.claude/worktrees/<name>[/...]: Claude Code EnterWorktree
  { re: /^(.*)\/\.claude\/worktrees\/[^/]+(?:\/|$)/, owner: (m) => path.basename(m[1]) },
  // ~/.cyrus/worktrees/<issue>[/...]: Cyrus checkouts carry no repo name in
  // the path, so they group under a single "cyrus" project.
  { re: /^.*\/\.cyrus\/worktrees\/[^/]+(?:\/|$)/, owner: () => 'cyrus' },
];

/**
 * Classify a session cwd.
 * @param {?string} cwd - The session's working directory
 * @returns {?{owningProject: ?string}} null when the cwd is not a recognized
 *   agent-worktree location; otherwise the project the session belongs to
 *   (null owningProject means "recognized worktree, owner unknown").
 */
function classifyAgentWorktree(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  for (const p of PATTERNS) {
    const m = cwd.match(p.re);
    if (m) {
      const owningProject = p.owner(m);
      return { owningProject: owningProject || null };
    }
  }
  return null;
}

module.exports = { classifyAgentWorktree };
