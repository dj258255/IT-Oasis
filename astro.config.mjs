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
        if (node.tagName === 'a' && node.properties?.href?.startsWith('/uploads/')) {
          node.properties.href = base + node.properties.href;
        }
      }
      if (node.children) node.children.forEach(visit);
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
    rehypePlugins: [rehypeBasePath, rehypeTableWrapper],
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
