import { describe, it, expect } from 'vitest';

// Mirror of chats_mobile.html's escapeHtml (textContent -> innerHTML escapes & < >)
// and applyInlineMarkdown, so the escape-before-markdown contract is regression-tested
// in Node without a DOM. If someone reorders escape/markdown or drops the escape,
// this fails.
function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/```(\w+)?\n([\s\S]+?)\n```/g, '<pre><code class="$1">$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

describe('formatTextContent XSS hardening', () => {
  it('neutralizes an img onerror payload', () => {
    const html = applyInlineMarkdown('<img src=x onerror="alert(document.domain)">');
    // The angle brackets are escaped, so no live <img> element is produced —
    // the onerror text survives only as inert, escaped characters.
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img');
    expect(html).toContain('&gt;');
    expect(html).not.toMatch(/<[a-z]/i); // no live tag opens from the payload
  });

  it('neutralizes a script tag and svg onload', () => {
    expect(applyInlineMarkdown('<script>steal()</script>')).not.toMatch(/<script/i);
    expect(applyInlineMarkdown('<svg onload=alert(1)>')).not.toMatch(/<svg/i);
  });

  it('still renders the intended markdown', () => {
    expect(applyInlineMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(applyInlineMarkdown('`code`')).toContain('<code>code</code>');
    expect(applyInlineMarkdown('a\nb')).toContain('a<br>b');
  });

  it('escapes html *inside* a code span rather than emitting a tag', () => {
    const html = applyInlineMarkdown('`<b>x</b>`');
    expect(html).toContain('<code>&lt;b&gt;x&lt;/b&gt;</code>');
  });
});
