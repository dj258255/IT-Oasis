interface RichTextNode {
  type: string;
  text?: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  url?: string;
  alt?: string;
  caption?: string;
  lang?: string;
  value?: string;
  children?: RichTextNode[];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderNode(node: RichTextNode, basePath: string): string {
  if (node.type === 'text') {
    let text = escapeHtml(node.text || '');
    if (node.code) text = `<code>${text}</code>`;
    if (node.bold) text = `<strong>${text}</strong>`;
    if (node.italic) text = `<em>${text}</em>`;
    return text;
  }

  const children = (node.children || []).map((c) => renderNode(c, basePath)).join('');

  switch (node.type) {
    case 'root':
      return children;
    case 'p':
      return `<p>${children}</p>\n`;
    case 'h1':
      return `<h1>${children}</h1>\n`;
    case 'h2':
      return `<h2>${children}</h2>\n`;
    case 'h3':
      return `<h3>${children}</h3>\n`;
    case 'h4':
      return `<h4>${children}</h4>\n`;
    case 'h5':
      return `<h5>${children}</h5>\n`;
    case 'h6':
      return `<h6>${children}</h6>\n`;
    case 'ul':
      return `<ul>${children}</ul>\n`;
    case 'ol':
      return `<ol>${children}</ol>\n`;
    case 'li':
      return `<li>${children}</li>`;
    case 'lic':
      return children;
    case 'blockquote':
      return `<blockquote>${children}</blockquote>\n`;
    case 'code_block':
      return `<pre><code${node.lang ? ` class="language-${node.lang}"` : ''}>${escapeHtml(node.value || children)}</code></pre>\n`;
    case 'hr':
      return '<hr />\n';
    case 'break':
      return '<br />';
    case 'img': {
      const src = (node.url || '').startsWith('/') ? `${basePath}${node.url}` : node.url || '';
      const alt = node.alt || '';
      const caption = node.caption || '';
      let html = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" />`;
      if (caption) html = `<figure>${html}<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
      return html + '\n';
    }
    case 'a':
      return `<a href="${escapeHtml(node.url || '')}">${children}</a>`;
    default:
      return children;
  }
}

export function renderRichText(content: RichTextNode | null | undefined, basePath: string = ''): string {
  if (!content) return '';
  return renderNode(content, basePath);
}
