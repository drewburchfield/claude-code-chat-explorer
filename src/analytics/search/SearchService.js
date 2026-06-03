/**
 * SearchService - the single search query path.
 *
 * Every search surface (REST API, MCP server, and the web UI via REST) routes
 * through this one service so they cannot drift apart in capability. It wraps
 * the database's FTS search and layers on filters, subagent control, grouping,
 * pagination, and facet discovery.
 *
 * FTS5 query operators (AND / OR / NOT, "exact phrase", prefix*, NEAR) are
 * passed through to the underlying engine. Results are conversation-level
 * (one row per conversation, best snippet + relevance).
 */
class SearchService {
  /**
   * @param {Object} db - DatabaseManager-like backend exposing
   *   searchConversationsWithSnippets(query, opts), getConversations(opts),
   *   and getSearchFacets().
   */
  constructor(db) {
    if (!db) throw new Error('SearchService requires a database backend');
    this.db = db;
    // Generous candidate cap pulled from FTS before in-memory filtering.
    this.CANDIDATE_LIMIT = 2000;
  }

  /**
   * Run a search.
   * @param {Object} params
   * @param {string} [params.query] - FTS query (operators supported). Empty => browse.
   * @param {string} [params.project] - Exact project name filter.
   * @param {string} [params.model] - Exact primary model filter.
   * @param {number} [params.dateFrom] - Min last_modified (ms epoch).
   * @param {number} [params.dateTo] - Max last_modified (ms epoch).
   * @param {boolean} [params.includeSubagents=false]
   * @param {boolean} [params.subagentsOnly=false]
   * @param {number} [params.limit=50]
   * @param {number} [params.offset=0]
   * @returns {{results: Array, total: number, appliedFilters: Object, searchMode: string, degraded: boolean}}
   */
  search(params = {}) {
    const {
      query = '',
      project = null,
      model = null,
      role = null,
      tool = null,
      dateFrom = null,
      dateTo = null,
      includeSubagents = false,
      subagentsOnly = false,
      limit = 50,
      offset = 0,
    } = params;

    const hasQuery = typeof query === 'string' && query.trim().length > 0;
    const wantSubagents = includeSubagents || subagentsOnly;
    let degraded = false;
    let candidates;
    let mode = 'browse';

    if (hasQuery && (role || tool)) {
      // Role/tool-granular path (per-message FTS). Requires the backend to
      // expose searchConversationsByRole.
      mode = 'fts-role';
      candidates = this.db.searchConversationsByRole(query, {
        role: role || null,
        tool: tool || null,
        includeSubagents: wantSubagents,
        limit: this.CANDIDATE_LIMIT,
        offset: 0,
      });
      degraded = !!candidates._searchDegraded;
    } else if (hasQuery) {
      mode = 'fts';
      candidates = this.db.searchConversationsWithSnippets(query, {
        includeSubagents: wantSubagents,
        limit: this.CANDIDATE_LIMIT,
        offset: 0,
      });
      // searchConversationsWithSnippets flags degraded mode on the array.
      degraded = !!candidates._searchDegraded;
    } else {
      candidates = this.db.getConversations({
        includeSubagents: includeSubagents || subagentsOnly,
        limit: this.CANDIDATE_LIMIT,
      });
    }

    const filtered = this._applyFilters(candidates, {
      project, model, dateFrom, dateTo, subagentsOnly,
    });

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    return {
      results: page,
      total,
      appliedFilters: { query: hasQuery ? query : null, project, model, role, tool, dateFrom, dateTo, includeSubagents, subagentsOnly },
      searchMode: mode,
      degraded,
    };
  }

  /**
   * Apply post-FTS filters that operate on conversation metadata.
   * @private
   */
  _applyFilters(rows, { project, model, dateFrom, dateTo, subagentsOnly }) {
    return rows.filter(r => {
      if (subagentsOnly && !r.isSubagent) return false;
      if (project && r.project !== project) return false;
      if (model && (r.modelInfo?.primaryModel || null) !== model) return false;
      if (dateFrom != null && this._ts(r.lastModified) < dateFrom) return false;
      if (dateTo != null && this._ts(r.lastModified) > dateTo) return false;
      return true;
    });
  }

  /** Normalize lastModified (Date | number | ISO string) to ms epoch. @private */
  _ts(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? 0 : t;
  }

  /**
   * Available facet values for building filter UIs / MCP enums.
   * @returns {{projects: string[], models: string[], tools: string[], dateRange: Object}}
   */
  facets() {
    return this.db.getSearchFacets();
  }
}

module.exports = SearchService;
