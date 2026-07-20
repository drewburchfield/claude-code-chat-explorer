/**
 * BlockRenderers unit tests.
 *
 * The renderer module lives under src/analytics-web so the browser can load
 * it directly, but it's authored as a UMD wrapper so vitest can require()
 * it under Node. Pinning the dispatch contract here is what stops a future
 * block type from being silently dropped by the renderer — the API
 * preserves blocks (covered in unknown-block-type.test.js), and these
 * tests cover that the UI knows what to do with the ones we've added
 * renderers for.
 */
import { describe, it, expect } from 'vitest';
const BlockRenderers = require('../../src/analytics-web/components/BlockRenderers.js');

describe('BlockRenderers.escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    const out = BlockRenderers.escapeHtml(`<script>alert("1")&'</script>`);
    expect(out).toBe('&lt;script&gt;alert(&quot;1&quot;)&amp;&#39;&lt;/script&gt;');
  });

  it('returns empty string for null/undefined input', () => {
    expect(BlockRenderers.escapeHtml(null)).toBe('');
    expect(BlockRenderers.escapeHtml(undefined)).toBe('');
  });
});

describe('BlockRenderers.formatThinkingBlock', () => {
  it('wraps the reasoning in a collapsible details element', () => {
    const html = BlockRenderers.formatThinkingBlock({ type: 'thinking', thinking: 'plan A' });
    expect(html).toMatch(/<details class="thinking-block">/);
    expect(html).toMatch(/<summary>/);
    expect(html).toMatch(/Claude.+reasoning/);
    expect(html).toMatch(/plan A/);
  });

  it('escapes HTML in the thinking text', () => {
    const html = BlockRenderers.formatThinkingBlock({
      type: 'thinking',
      thinking: '<img onerror=alert(1) />',
    });
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/&lt;img/);
  });

  it('tolerates a missing thinking field', () => {
    const html = BlockRenderers.formatThinkingBlock({ type: 'thinking' });
    expect(html).toMatch(/<details class="thinking-block">/);
  });
});

describe('BlockRenderers.formatImageBlock', () => {
  it('renders a base64 PNG into a data URL', () => {
    const html = BlockRenderers.formatImageBlock({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
    expect(html).toMatch(/<img src="data:image\/png;base64,iVBORw0KGgo="/);
    expect(html).toMatch(/loading="lazy"/);
  });

  it('renders an https URL source', () => {
    const html = BlockRenderers.formatImageBlock({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.png' },
    });
    expect(html).toMatch(/<img src="https:\/\/example.com\/cat.png"/);
  });

  it('rejects media types outside the image allowlist', () => {
    // text/html in a data URL would otherwise let an attacker render
    // arbitrary HTML through the renderer pipeline.
    const html = BlockRenderers.formatImageBlock({
      type: 'image',
      source: { type: 'base64', media_type: 'text/html', data: 'PHNjcmlwdD4=' },
    });
    expect(html).toMatch(/unknown-block/);
    expect(html).not.toMatch(/<img/);
  });

  it('rejects non-base64 characters in the data field', () => {
    const html = BlockRenderers.formatImageBlock({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA"onerror=alert(1)' },
    });
    expect(html).toMatch(/unknown-block/);
  });

  it('rejects non-http(s) URL schemes', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const html = BlockRenderers.formatImageBlock({
        type: 'image',
        source: { type: 'url', url },
      });
      expect(html).toMatch(/unknown-block/);
    }
  });

  it('falls back to the unknown placeholder when source is missing', () => {
    const html = BlockRenderers.formatImageBlock({ type: 'image' });
    expect(html).toMatch(/unknown-block/);
  });
});

describe('BlockRenderers.dispatchBlock', () => {
  it('returns a thinking-block render for type=thinking', () => {
    const html = BlockRenderers.dispatchBlock({ type: 'thinking', thinking: 'x' });
    expect(html).toMatch(/thinking-block/);
  });

  it('returns an image-block render for type=image with a valid source', () => {
    const html = BlockRenderers.dispatchBlock({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBOR=' },
    });
    expect(html).toMatch(/image-block/);
  });

  it('returns null for text/tool_use/tool_result so caller dispatches them', () => {
    expect(BlockRenderers.dispatchBlock({ type: 'text', text: 'hi' })).toBeNull();
    expect(BlockRenderers.dispatchBlock({ type: 'tool_use', id: 't1', name: 'Bash' })).toBeNull();
    expect(BlockRenderers.dispatchBlock({ type: 'tool_result', tool_use_id: 't1', content: 'x' })).toBeNull();
  });

  it('returns the unknown placeholder for null/non-objects', () => {
    expect(BlockRenderers.dispatchBlock(null)).toMatch(/unknown-block/);
    expect(BlockRenderers.dispatchBlock('not-an-object')).toMatch(/unknown-block/);
  });

  it('returns the unknown placeholder for genuinely unknown types', () => {
    expect(BlockRenderers.dispatchBlock({ type: 'queue-operation' })).toMatch(/unknown-block/);
  });
});

describe('BlockRenderers.formatTextContent', () => {
  it('escapes active HTML before adding markdown markup', () => {
    const html = BlockRenderers.formatTextContent('<img src=x onerror="alert(1)"> **safe bold**');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('<strong>safe bold</strong>');
  });

  it('escapes HTML inside fenced and inline code', () => {
    const html = BlockRenderers.formatTextContent('```html\n<script>alert(1)</script>\n``` `</code>`');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;/code&gt;');
  });
});

describe('BlockRenderers.RENDERED_BLOCK_TYPES', () => {
  it('exposes the set of block types this module renders explicitly', () => {
    expect(BlockRenderers.RENDERED_BLOCK_TYPES.has('thinking')).toBe(true);
    expect(BlockRenderers.RENDERED_BLOCK_TYPES.has('image')).toBe(true);
    expect(BlockRenderers.RENDERED_BLOCK_TYPES.has('text')).toBe(false);
  });
});
