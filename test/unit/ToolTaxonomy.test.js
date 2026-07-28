/**
 * Unit tests for ToolTaxonomy (ported from flight-recorder's adapter tests).
 */
import { describe, it, expect } from 'vitest';
const { toolKind, fileChangeFromTool } = require('../../src/analytics/core/ToolTaxonomy.js');

describe('toolKind', () => {
  it('parses the MCP server name from mcp__<server>__<tool>', () => {
    expect(toolKind('mcp__exa__web_search_exa')).toEqual({ kind: 'mcp', mcp: 'exa' });
    expect(toolKind('mcp__claude-in-chrome__navigate')).toEqual({ kind: 'mcp', mcp: 'claude-in-chrome' });
  });

  it('handles a malformed mcp name without a server segment', () => {
    expect(toolKind('mcp__')).toEqual({ kind: 'mcp', mcp: null });
  });

  it('buckets the core tools case-insensitively', () => {
    expect(toolKind('Bash').kind).toBe('shell');
    expect(toolKind('Edit').kind).toBe('file_edit');
    expect(toolKind('MultiEdit').kind).toBe('file_edit');
    expect(toolKind('Write').kind).toBe('file_edit');
    expect(toolKind('NotebookEdit').kind).toBe('file_edit');
    expect(toolKind('Read').kind).toBe('file_read');
    expect(toolKind('Grep').kind).toBe('search');
    expect(toolKind('Glob').kind).toBe('search');
    expect(toolKind('WebSearch').kind).toBe('search');
    expect(toolKind('Task').kind).toBe('task');
    expect(toolKind('WebFetch').kind).toBe('web');
  });

  it('falls back to other for unknown and invalid names', () => {
    expect(toolKind('TodoWrite').kind).toBe('other');
    expect(toolKind('')).toEqual({ kind: 'other', mcp: null });
    expect(toolKind(null).kind).toBe('other');
    expect(toolKind(undefined).kind).toBe('other');
  });
});

describe('fileChangeFromTool', () => {
  it('Write becomes a create with added lines from content', () => {
    const fc = fileChangeFromTool('Write', { file_path: 'b.ts', content: 'line1\nline2' });
    expect(fc).toEqual({ path: 'b.ts', change_kind: 'create', added_lines: 2, removed_lines: 0 });
  });

  it('Edit counts old and new lines; kind is edit, never guessed as create', () => {
    const fc = fileChangeFromTool('Edit', {
      file_path: 'src/a.ts', old_string: 'a\nb\nc', new_string: 'a\nb',
    });
    expect(fc).toEqual({ path: 'src/a.ts', change_kind: 'edit', added_lines: 2, removed_lines: 3 });
  });

  it('MultiEdit sums line counts across edits', () => {
    const fc = fileChangeFromTool('MultiEdit', {
      file_path: 'src/m.ts',
      edits: [
        { old_string: 'x', new_string: 'y\nz' },
        { old_string: 'p\nq', new_string: 'r' },
      ],
    });
    expect(fc).toEqual({ path: 'src/m.ts', change_kind: 'edit', added_lines: 3, removed_lines: 3 });
  });

  it('MultiEdit skips malformed entries in the edits array', () => {
    const fc = fileChangeFromTool('MultiEdit', {
      file_path: 'src/m.ts',
      edits: [null, 'junk', { old_string: 'a', new_string: 'b' }],
    });
    expect(fc).toEqual({ path: 'src/m.ts', change_kind: 'edit', added_lines: 1, removed_lines: 1 });
  });

  it('NotebookEdit uses notebook_path and new_source', () => {
    const fc = fileChangeFromTool('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'a\nb\nc' });
    expect(fc).toEqual({ path: 'n.ipynb', change_kind: 'edit', added_lines: 3, removed_lines: 0 });
  });

  it('returns null when the path is missing, input is absent, or the tool does not edit files', () => {
    expect(fileChangeFromTool('Write', { content: 'x' })).toBeNull();
    expect(fileChangeFromTool('Edit', null)).toBeNull();
    expect(fileChangeFromTool('MultiEdit', { file_path: 'a', edits: 'nope' })).toBeNull();
    expect(fileChangeFromTool('Bash', { command: 'rm x' })).toBeNull();
    expect(fileChangeFromTool('Read', { file_path: 'a' })).toBeNull();
  });
});
