// @ts-check
import { defineConfig } from 'astro/config';
import expressiveCode from 'astro-expressive-code';
import remarkGithubAlerts from 'remark-github-blockquote-alert';
import tailwindcss from '@tailwindcss/vite';

const isProd = process.env.CI === 'true';

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
  base: isProd ? '/IT-Oasis' : '/',
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
    rehypePlugins: [rehypeTableWrapper],
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
