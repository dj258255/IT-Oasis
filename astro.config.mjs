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
    // 빌려조잉 13편 -> joying-retrospective 단일 개발기로 병합
    '/blog/project/joying/kotlin-lombok-interop': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/jwt-cookie-security': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/mysql-mongodb-redis-why': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/kafka-was-overkill': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/chat-message-ordering': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/chatroom-list-slow-query': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/message-auth-db-check': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/coroutine-jpa-401': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/inbound-thread-optimization': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/websocket-message-loss': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/server-scaling-troubleshooting': `${base || ''}/blog/project/joying/joying-retrospective`,
    '/blog/project/joying/redis-security-issue': `${base || ''}/blog/project/joying/joying-retrospective`,
    // 오락가락 9편 -> orakgarak-retrospective 단일 개발기로 병합
    '/blog/project/orakgarak/prometheus-grafana-loki-monitoring': `${base || ''}/blog/project/orakgarak/orakgarak-retrospective`,
    '/blog/project/orakgarak/spring-security-multi-filterchain': `${base || ''}/blog/project/orakgarak/orakgarak-retrospective`,
    '/blog/project/orakgarak/presigned-url-eventbridge-upload': `${base || ''}/blog/project/orakgarak/orakgarak-retrospective`,
    '/blog/project/orakgarak/kafka-event-driven-pipeline': `${base || ''}/blog/project/orakgarak/orakgarak-retrospective`,
    '/blog/project/orakgarak/ts-gpu-oom-concurrent-requests': `${base || ''}/blog/project/orakgarak/orakgarak-retrospective`,
    '/blog/project/orakgarak/ts-kafka-partition-imbalance': `${base || ''}/blog/project/orakgarak/orakgarak-retrospective`,
    '/blog/project/orakgarak/ts-loki-stacktrace-parsing': `${base || ''}/blog/project/orakgarak/orakgarak-retrospective`,
    '/blog/project/orakgarak/ts-prometheus-alert-noise': `${base || ''}/blog/project/orakgarak/orakgarak-retrospective`,
    // EduMeet 9편 -> edumeet-retrospective 단일 개발기로 병합
    '/blog/project/edumeet/architecture-evolution': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/onetomany-join-table': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/lazy-loading-no-session': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/n-plus-1-issue': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/file-move-error': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/s3-upload-optimization': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/unit-test-db-migration': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/edge-case-issues': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    // EduMeet 재작업 15편 -> 주제별 9편으로 병합 (2026-08-28)
    '/blog/project/edumeet/egress-cost-model': `${base || ''}/blog/project/edumeet/own-hls`,
    '/blog/project/edumeet/mcp-transcript-server': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    '/blog/project/edumeet/unrunnable-code': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    // 모노레포 합치기·CI 이관·Flyway 가 한 글에 묶여 있어 어느 것도 검색어가 안 됐다.
    // 살릴 사실(git subtree 이력 끊김)은 저장소 docs/ 에 남기고 글은 접었다.
    '/blog/project/edumeet/monorepo-revealed': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    // 셋 다 프로젝트 진행 기록에 가까웠다. 각각에 한 조각씩 쓸 만한 게 있어
    // 지우지 않고 한 편으로 합쳤다(하트비트 · 과금 단위 · 베이스라인).
    '/blog/project/edumeet/reaching-the-screen': `${base || ''}/blog/project/edumeet/captions-ahead-of-video`,
    '/blog/project/edumeet/caption-to-summary': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    '/blog/project/edumeet/measure-before-the-model': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    '/blog/project/edumeet/deploy-and-migration': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/three-questions-measured': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    '/blog/project/edumeet/chicken-and-egg': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    // EduMeet 9편 -> 8편 (2026-08-31)
    //
    // ★ 기준을 "정보가 쓸모 있는가" 에서 "포폴로서 값이 있는가" 로 옮겼다.
    //   쓸모 있는 정보인데 글의 논지가 약하면, 그 정보만 다른 글로 옮기고 글은 접는다.
    //
    //   config-that-does-nothing  내 설정 버그 6개 목록으로 읽혔다. 재사용되는 둘
    //                             (목록 마지막 줄이 위를 삼킨다 · /error 가 404를 401로)만
    //                             ops-that-look-installed 로 옮겼다
    //   measuring-on-the-real-server  5개 중 3개가 다른 글과 겹쳤다. 고유한 둘
    //                             (dockerd CPU · nginx 60초)을 각각 옮기고 접었다
    //   realtime-caption-decisions  세 항목이 서로 무관했다. 가장 강한 하나를
    //                             baseline-before-model 로 다시 세웠다
    '/blog/project/edumeet/config-that-does-nothing': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    '/blog/project/edumeet/measuring-on-the-real-server': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    '/blog/project/edumeet/realtime-caption-decisions': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    // ops-that-look-installed 를 접었다 (2026-08-31)
    //
    // ★ 기준이 한 겹 더 내려갔다 - "정보가 쓸모 있는가" 도 아니고
    //   "이걸 굳이 글로 적어야 하나" 다.
    //
    //   그 글의 여섯 항목(백업 복구 확인 · SELinux · 하트비트 스케줄러 ·
    //   nginx proxy_read_timeout · permitAll 목록 · /error)은 전부
    //   검색하면 나오는 것이고, 포폴에서는 "기본 설정을 몰랐구나" 로 읽힌다.
    //
    //   같은 발견도 "왜 아무도 못 봤는가" 를 답하면 통찰이 되고
    //   "내가 몰랐다" 로 끝나면 함정 목록이 된다. 그 질문에 답하는 항목이
    //   하나뿐이어서(부하를 걸면 사라지는 버그) 그것만 limits-i-wrote-down 으로 옮겼다.
    '/blog/project/edumeet/ops-that-look-installed': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    // baseline-before-model · alerting-with-measured-thresholds 를 접었다 (2026-08-31)
    //
    // ★ 기준 - "결과물이 있는가".
    //   baseline 글은 임베딩을 선택 의존성으로 빼고 기본값을 끄기로 한 이야기라
    //   글 전체가 "안 한 것" 이다. 이 시리즈에 "재보고 안 썼다" 는 이미 여럿 있는데
    //   그것들은 본체 작업 안의 판단이고 이건 글 자체에 결과물이 없다.
    //
    //   alerting 글은 자기정정 한 단락이 강했지만 그것만으로 한 편을 못 지탱했고,
    //   관측·경보 비중이 이미 컸다.
    //
    //   둘의 알맹이(비교 대상이 약하면 개선폭이 부풀려진다 · 근거를 적은 것과
    //   근거가 맞는 것은 다르다)는 limits-i-wrote-down 으로 옮겼다.
    //   그 글 주제가 "숫자를 못 믿게 만드는 것" 이라 정확히 맞는다.
    '/blog/project/edumeet/baseline-before-model': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    '/blog/project/edumeet/alerting-with-measured-thresholds': `${base || ''}/blog/project/edumeet/limits-i-wrote-down`,
    // zero-downtime-deploy 를 접었다 (2026-08-31)
    //
    // ★ 기준 - "해결한 문제가 실재했는가".
    //   사용자가 없는 서비스에서 배포 중단 20.5초는 아무 피해가 아니다.
    //   0으로 만든 것은 "할 수 있다" 의 증명이지 "필요했다" 가 아니다.
    //
    //   다만 그 작업이 실제로 값을 한 순간은 있었다 - Origin 을 고치는 동안
    //   배포가 네 번 실패했는데 서비스가 한 번도 안 끊겼다. 그 한 문단만
    //   captions-ahead-of-video 로 옮겼다.
    '/blog/project/edumeet/zero-downtime-deploy': `${base || ''}/blog/project/edumeet/captions-ahead-of-video`,
    // gwanmun 6편 -> gwanmun-0-why 단일 개발기로 병합
    '/blog/project/gwanmun/gwanmun-1-parser-and-framing': `${base || ''}/blog/project/gwanmun/gwanmun-0-why`,
    '/blog/project/gwanmun/gwanmun-2-gateway-skeleton': `${base || ''}/blog/project/gwanmun/gwanmun-0-why`,
    '/blog/project/gwanmun/gwanmun-3-ledger-and-resilience': `${base || ''}/blog/project/gwanmun/gwanmun-0-why`,
    '/blog/project/gwanmun/gwanmun-4-audit-and-load': `${base || ''}/blog/project/gwanmun/gwanmun-0-why`,
    '/blog/project/gwanmun/gwanmun-5-idempotency-reconciliation': `${base || ''}/blog/project/gwanmun/gwanmun-0-why`,
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
