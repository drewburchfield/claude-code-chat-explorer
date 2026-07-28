/**
 * ToolTaxonomy - classify tool_use blocks and extract file changes.
 *
 * Ported from flight-recorder's Claude adapter (ingest/src/adapters/claude.ts).
 * Pure functions, no dependencies; both the indexer (write path) and the
 * database layer (backfill/queries) use this one module so the taxonomy
 * cannot drift between them.
 */

/**
 * Bucket a tool name into a coarse kind, extracting the MCP server name
 * from the mcp__<server>__<tool> convention.
 * @param {string} name - Tool name as it appears in the tool_use block
 * @returns {{kind: string, mcp: ?string}} kind is one of:
 *   mcp | shell | file_edit | file_read | search | task | web | other
 */
function toolKind(name) {
  if (typeof name !== 'string' || !name) return { kind: 'other', mcp: null };
  if (name.startsWith('mcp__')) return { kind: 'mcp', mcp: name.split('__')[1] || null };
  const n = name.toLowerCase();
  if (['bash', 'exec_command'].includes(n)) return { kind: 'shell', mcp: null };
  if (['edit', 'write', 'multiedit', 'notebookedit'].includes(n)) return { kind: 'file_edit', mcp: null };
  if (['read', 'notebookread'].includes(n)) return { kind: 'file_read', mcp: null };
  if (['grep', 'glob', 'websearch', 'toolsearch'].includes(n)) return { kind: 'search', mcp: null };
  if (['task', 'agent'].includes(n)) return { kind: 'task', mcp: null };
  if (['webfetch'].includes(n)) return { kind: 'web', mcp: null };
  return { kind: 'other', mcp: null };
}

/** Count newlines-delimited lines in a string ('' and null count as 0). */
function countLines(s) {
  return s ? String(s).split('\n').length : 0;
}

/**
 * Extract a file change from an Edit/Write/MultiEdit/NotebookEdit tool_use
 * block. Line counts derive from the old/new strings, so they describe the
 * requested change, not a post-hoc diff.
 * @param {string} name - Tool name
 * @param {Object} input - The tool_use input payload
 * @returns {?{path: string, change_kind: string, added_lines: number, removed_lines: number}}
 */
function fileChangeFromTool(name, input) {
  if (!input || typeof name !== 'string') return null;
  const n = name.toLowerCase();
  if (n === 'write') {
    if (!input.file_path) return null;
    return { path: input.file_path, change_kind: 'create', added_lines: countLines(input.content), removed_lines: 0 };
  }
  if (n === 'edit') {
    if (!input.file_path) return null;
    return { path: input.file_path, change_kind: 'edit', added_lines: countLines(input.new_string), removed_lines: countLines(input.old_string) };
  }
  if (n === 'multiedit') {
    if (!input.file_path || !Array.isArray(input.edits)) return null;
    let added = 0, removed = 0;
    for (const e of input.edits) {
      if (!e || typeof e !== 'object') continue;
      added += countLines(e.new_string);
      removed += countLines(e.old_string);
    }
    return { path: input.file_path, change_kind: 'edit', added_lines: added, removed_lines: removed };
  }
  if (n === 'notebookedit') {
    if (!input.notebook_path) return null;
    return { path: input.notebook_path, change_kind: 'edit', added_lines: countLines(input.new_source), removed_lines: 0 };
  }
  return null;
}

module.exports = { toolKind, fileChangeFromTool };
