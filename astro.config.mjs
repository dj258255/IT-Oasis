// @ts-check
import { defineConfig } from 'astro/config';
import expressiveCode from 'astro-expressive-code';
import { pluginLineNumbers } from '@expressive-code/plugin-line-numbers';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
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
  // 여러 편을 한 편으로 합치면서 사라진 URL. 정적 빌드에서는
  // meta refresh 페이지가 생성돼 기존 링크가 안 깨진다.
  redirects: {
    '/blog/incident/currency-anomaly-detection': `${base || ''}/blog/incident/currency-reclaim`,
    // 타이미 15편 -> tymee-retrospective 단일 개발기로 병합
    '/blog/project/tymee/tymee-introduction': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/tymee-architecture-selection': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/gradle-multimodule-dependency': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/spring-boot-config': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/exception-handling-design': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/snowflake-id': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/flyway-db-migration': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/code-quality-management': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/current-user-annotation': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/mapstruct-usage': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/mobile-jwt-auth': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/orphan-file-cleanup': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/spring-boot4-api-versioning': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    '/blog/project/tymee/spring-boot4-swagger-conflict': `${base || ''}/blog/project/tymee/tymee-retrospective`,
    // 발루노 6편 -> balruno-retrospective 단일 개발기로 병합
    '/blog/project/balruno/indie-balance-tool-market-research': `${base || ''}/blog/project/balruno/balruno-retrospective`,
    '/blog/project/balruno/game-design-tool-intro': `${base || ''}/blog/project/balruno/balruno-retrospective`,
    '/blog/project/balruno/balruno-mvp-release': `${base || ''}/blog/project/balruno/balruno-retrospective`,
    '/blog/project/balruno/table-input-ux': `${base || ''}/blog/project/balruno/balruno-retrospective`,
    '/blog/project/balruno/user-feedback': `${base || ''}/blog/project/balruno/balruno-retrospective`,
    '/blog/project/balruno/powerbalance-lesson': `${base || ''}/blog/project/balruno/balruno-retrospective`,
  },
  build: {
    concurrency: 1,
  },
  integrations: [
    expressiveCode({
      plugins: [pluginLineNumbers()],
      themes: ['catppuccin-mocha', 'catppuccin-latte'],
      themeCssSelector: (theme) =>
        theme.type === 'dark' ? '.dark' : ':root:not(.dark)',
      styleOverrides: {
        borderRadius: '0.75rem',
        borderColor: 'rgba(100, 160, 200, 0.2)',
        codePaddingBlock: '1.25rem',
        codePaddingInline: '1.5rem',
        codeFontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        codeFontSize: '0.85rem',
        codeLineHeight: '1.75',
        frames: {
          frameBoxShadowCssValue:
            '0 4px 16px rgba(0,0,0,0.08), 0 12px 40px rgba(0,0,0,0.06)',
        },
      },
      defaultProps: {
        wrap: false,
        // Line numbers on every code block by default
        showLineNumbers: true,
      },
    }),
  ],
  markdown: {
    gfm: false,
    remarkPlugins: [[remarkGfm, { singleTilde: false }], remarkBreaks, remarkGithubAlerts],
    rehypePlugins: [rehypeBasePath, rehypeCjkBold, rehypeTableWrapper],
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
