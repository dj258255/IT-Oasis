// @ts-check
import { defineConfig } from 'astro/config';
import expressiveCode from 'astro-expressive-code';
import remarkGithubAlerts from 'remark-github-blockquote-alert';
import tailwindcss from '@tailwindcss/vite';

const isProd = process.env.CI === 'true';
const base = isProd ? '/IT-Oasis' : '';

/** Rehype plugin: prepend base path to absolute image/link src in markdown body */
function rehypeBasePath() {
  return (tree) => {
    if (!base) return;
    function visit(node) {
      if (node.type === 'element') {
        if (node.tagName === 'img' && node.properties?.src?.startsWith('/')) {
          node.properties.src = base + node.properties.src;
        }
        if (node.tagName === 'a') {
          const href = node.properties?.href;
          if (href && href.startsWith('/') && !href.startsWith('//')) {
            node.properties.href = base + href;
          }
        }
      }
      if (node.children) node.children.forEach(visit);
    }
    visit(tree);
  };
}

/** Rehype plugin: fix **bold** not parsed when followed by CJK without space.
 *  CommonMark treats closing ** as non-right-flanking when preceded by punctuation
 *  and followed by non-punctuation (e.g. **역색인(index)**이라는).
 *  This post-processes text nodes to convert leftover **…** into <strong>. */
function rehypeCjkBold() {
  const BOLD_RE = /\*\*(.+?)\*\*/g;
  const SKIP_TAGS = new Set(['pre', 'code', 'script', 'style']);
  return (tree) => {
    function visit(node) {
      if (!node.children) return;
      if (node.type === 'element' && SKIP_TAGS.has(node.tagName)) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type === 'text' && BOLD_RE.test(child.value)) {
          const parts = [];
          let last = 0;
          BOLD_RE.lastIndex = 0;
          let m;
          while ((m = BOLD_RE.exec(child.value)) !== null) {
            if (m.index > last) {
              parts.push({ type: 'text', value: child.value.slice(last, m.index) });
            }
            parts.push({
              type: 'element',
              tagName: 'strong',
              properties: {},
              children: [{ type: 'text', value: m[1] }],
            });
            last = BOLD_RE.lastIndex;
          }
          if (last < child.value.length) {
            parts.push({ type: 'text', value: child.value.slice(last) });
          }
          node.children.splice(i, 1, ...parts);
          i += parts.length - 1;
        } else {
          visit(child);
        }
      }
    }
    visit(tree);
  };
}

/** Rehype plugin: wrap <table> in a scrollable div */
function rehypeTableWrapper() {
  return (tree) => {
    function visit(node) {
      if (!node.children) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type === 'element' && child.tagName === 'table') {
          node.children[i] = {
            type: 'element',
            tagName: 'div',
            properties: { className: ['table-wrapper'] },
            children: [child],
          };
        } else {
          visit(child);
        }
      }
    }
    visit(tree);
  };
}

// https://astro.build/config
export default defineConfig({
  site: isProd ? 'https://dj258255.github.io' : 'http://localhost:4321',
  base: base || '/',
  output: 'static',
  integrations: [
    expressiveCode({
      themes: ['catppuccin-mocha', 'catppuccin-latte'],
      themeCssSelector: (theme) =>
        theme.type === 'dark' ? '.dark' : ':root:not(.dark)',
      styleOverrides: {
        borderRadius: '0.75rem',
        borderColor: 'rgba(100, 160, 200, 0.2)',
        codePaddingBlock: '1.25rem',
        codePaddingInline: '1.5rem',
        codeFontSize: '0.85rem',
        codeLineHeight: '1.75',
        frames: {
          frameBoxShadowCssValue:
            '0 4px 16px rgba(0,0,0,0.08), 0 12px 40px rgba(0,0,0,0.06)',
        },
      },
      defaultProps: {
        wrap: false,
      },
    }),
  ],
  markdown: {
    remarkPlugins: [remarkGithubAlerts],
    rehypePlugins: [rehypeBasePath, rehypeCjkBold, rehypeTableWrapper],
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
