/**
 * BlockRenderers — block-type → HTML dispatch for Claude transcript content
 * blocks.
 *
 * Exposes itself as a UMD module so the browser bundle can pick it up via
 * <script src="/components/BlockRenderers.js"> and unit tests can `require`
 * it under Node. Keeping the dispatch testable is what protects us from
 * silently dropping a future block type a la pre-PR1 behaviour: a renderer
 * regression now fails a unit test instead of a "huh, where did that go?"
 * during dogfooding.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BlockRenderers = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
  }

  /**
   * Render the small markdown subset used by the chat view. Escaping must
   * happen before markup is added: transcript text can contain HTML copied
   * from repositories, web pages, tool output, or another model.
   */
  function formatTextContent(value) {
    return escapeHtml(value)
      .replace(/```(\w+)?\n([\s\S]+?)\n```/g, '<pre><code class="$1">$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  /**
   * `image` blocks come in two shapes from the Claude API:
   *   - { type: 'image', source: { type: 'base64', media_type, data } }
   *   - { type: 'image', source: { type: 'url', url } }
   * Anything else is treated as unknown so we don't construct an attribute
   * value we can't vouch for.
   */
  function buildImageSrc(source) {
    if (!source || typeof source !== 'object') return null;
    if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
      // Restrict media type to a conservative allowlist so we can't be
      // tricked into rendering text/html or application/javascript via a
      // base64 data URL.
      const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      if (!allowed.has(source.media_type)) return null;
      // Base64 charset only — anything else and we refuse to build the URL.
      if (!/^[A-Za-z0-9+/=\s]*$/.test(source.data)) return null;
      return 'data:' + source.media_type + ';base64,' + source.data.replace(/\s+/g, '');
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      // Only http(s) URLs render. Anything else (data:, javascript:, file:)
      // gets rejected up front.
      try {
        const parsed = new URL(source.url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.toString();
        }
      } catch (_) { /* fall through */ }
      return null;
    }
    return null;
  }

  function formatImageBlock(block) {
    const src = buildImageSrc(block && block.source);
    if (!src) {
      return formatUnknownBlock(block);
    }
    return (
      '<figure class="image-block">' +
      '<img src="' + escapeHtml(src) + '" alt="Attached image" loading="lazy" />' +
      '</figure>'
    );
  }

  /**
   * Thinking blocks are large free-form prose. Render collapsed by default
   * so they don't blow out the message column; the user opens them when
   * they actually want to read Claude's reasoning.
   */
  function formatThinkingBlock(block) {
    const text = block && typeof block.thinking === 'string' ? block.thinking : '';
    return (
      '<details class="thinking-block">' +
      '<summary>' +
      '<span class="thinking-block-icon">💭</span>' +
      '<span class="thinking-block-label">Claude’s reasoning</span>' +
      '</summary>' +
      '<div class="thinking-block-content">' + escapeHtml(text) + '</div>' +
      '</details>'
    );
  }

  function formatUnknownBlock(block) {
    const safeType = escapeHtml(block && block.type ? block.type : 'unknown');
    return (
      '<div class="unknown-block" ' +
      'title="This block type is not yet rendered by the chat explorer. ' +
      'The underlying content is preserved on disk.">' +
      '<span class="unknown-block-icon">⚠️</span>' +
      '<span class="unknown-block-label">Unhandled block type:</span> ' +
      '<code>' + safeType + '</code>' +
      '</div>'
    );
  }

  // Block types this module knows how to render. Anything outside this set
  // falls through to formatUnknownBlock so the user can still see that
  // there was content here.
  const RENDERED_BLOCK_TYPES = new Set(['thinking', 'image']);

  // Block types the caller handles via its own renderers (text, tool_use,
  // tool_result). For these, dispatchBlock returns null so the caller can
  // fall through to its existing branches without double-rendering.
  const CALLER_HANDLED_TYPES = new Set(['text', 'tool_use', 'tool_result']);

  /**
   * Render a block to its HTML. Returns null if the caller's existing
   * dispatch should handle this block (text / tool_use / tool_result), an
   * HTML string for thinking / image / unknown otherwise.
   */
  function dispatchBlock(block) {
    if (!block || typeof block !== 'object') return formatUnknownBlock(block);
    if (CALLER_HANDLED_TYPES.has(block.type)) return null;
    if (block.type === 'thinking') return formatThinkingBlock(block);
    if (block.type === 'image') return formatImageBlock(block);
    return formatUnknownBlock(block);
  }

  return {
    escapeHtml,
    formatTextContent,
    buildImageSrc,
    formatThinkingBlock,
    formatImageBlock,
    formatUnknownBlock,
    dispatchBlock,
    RENDERED_BLOCK_TYPES,
  };
}));
