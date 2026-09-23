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
    // 내려간 글 7편은 새 슬러그로도 들어올 수 있다 — 본문 곳곳이 아직 그 편을 가리킨다.
    // 이름이 바뀌기 전에도 같은 식으로 개요로 보내고 있었다.
    '/blog/project/be-commerce/be-commerce-ch1-what-to-trust': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/be-commerce/be-commerce-ch15-webhook-arrived-first': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/be-commerce/be-commerce-ch2-concurrency-and-load': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/be-commerce/be-commerce-ch2-runtime-truths': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/be-commerce/be-commerce-ch3-money-leaks': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/be-commerce/be-commerce-ch4-my-docs-were-wrong': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/be-commerce/be-commerce-ch7-measuring-wrong': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    // 프로젝트 이름이 pay 에서 BE-commerce 로 바뀌면서 슬러그가 통째로 바뀌었다.
    // 위 목적지들은 새 주소로 옮겼고, 여기서는 아직 매핑이 없던 옛 주소를 새 주소로 보낸다.
    '/blog/portfolio-pay': `${base || ''}/blog/portfolio-be-commerce`,
    '/blog/project/pay/pay-0-overview': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch10-ruler-first': `${base || ''}/blog/project/be-commerce/be-commerce-ch10-ruler-first`,
    '/blog/project/pay/pay-ch11-ruler-fooled-me': `${base || ''}/blog/project/be-commerce/be-commerce-ch11-ruler-fooled-me`,
    '/blog/project/pay/pay-ch13-residual-cause': `${base || ''}/blog/project/be-commerce/be-commerce-ch13-residual-cause`,
    '/blog/project/pay/pay-ch14-when-the-ruler-says-yes': `${base || ''}/blog/project/be-commerce/be-commerce-ch14-when-the-ruler-says-yes`,
    '/blog/project/pay/pay-ch16-no-hangul-on-the-list': `${base || ''}/blog/project/be-commerce/be-commerce-ch16-no-hangul-on-the-list`,
    '/blog/project/pay/pay-ch17-db-rejected-it': `${base || ''}/blog/project/be-commerce/be-commerce-ch17-db-rejected-it`,
    '/blog/project/pay/pay-ch18-settlement-fairness': `${base || ''}/blog/project/be-commerce/be-commerce-ch18-settlement-fairness`,
    '/blog/project/pay/pay-ch19-virtual-account-reversal': `${base || ''}/blog/project/be-commerce/be-commerce-ch19-virtual-account-reversal`,
    '/blog/project/pay/pay-ch2-failure-design': `${base || ''}/blog/project/be-commerce/be-commerce-ch2-failure-design`,
    '/blog/project/pay/pay-ch20-fds-block-ignored': `${base || ''}/blog/project/be-commerce/be-commerce-ch20-fds-block-ignored`,
    '/blog/project/pay/pay-ch21-cancel-row-overwrite': `${base || ''}/blog/project/be-commerce/be-commerce-ch21-cancel-row-overwrite`,
    '/blog/project/pay/pay-ch22-parser-drops-refund': `${base || ''}/blog/project/be-commerce/be-commerce-ch22-parser-drops-refund`,
    '/blog/project/pay/pay-ch23-receiver-decides-guards': `${base || ''}/blog/project/be-commerce/be-commerce-ch23-receiver-decides-guards`,
    '/blog/project/pay/pay-ch24-judge-order-flip': `${base || ''}/blog/project/be-commerce/be-commerce-ch24-judge-order-flip`,
    '/blog/project/pay/pay-ch25-payment-integrity-operations': `${base || ''}/blog/project/be-commerce/be-commerce-ch25-payment-integrity-operations`,
    '/blog/project/pay/pay-ch26-payment-retries-retry-storm': `${base || ''}/blog/project/be-commerce/be-commerce-ch26-payment-retries-retry-storm`,
    '/blog/project/pay/pay-ch27-pending-posted-reconciliation': `${base || ''}/blog/project/be-commerce/be-commerce-ch27-pending-posted-reconciliation`,
    '/blog/project/pay/pay-ch28-payment-orchestration-tradeoff': `${base || ''}/blog/project/be-commerce/be-commerce-ch28-payment-orchestration-tradeoff`,
    '/blog/project/pay/pay-ch29-ledger-hot-entity': `${base || ''}/blog/project/be-commerce/be-commerce-ch29-ledger-hot-entity`,
    '/blog/project/pay/pay-ch30-where-automation-stops': `${base || ''}/blog/project/be-commerce/be-commerce-ch30-where-automation-stops`,
    '/blog/project/pay/pay-ch6-auth-cost': `${base || ''}/blog/project/be-commerce/be-commerce-ch6-auth-cost`,
    '/blog/project/pay/pay-ch8-reconciliation-judgement': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-ch9-batch-ownership': `${base || ''}/blog/project/be-commerce/be-commerce-ch9-batch-ownership`,
    // AI 글 2편을 1편으로 통합. 옛 슬러그 둘을 통합본으로 보낸다
    '/blog/ai/review-surface-not-review-speed': `${base || ''}/blog/ai/ai-guardrails-before-codegen`,
    '/blog/ai/toss-frontend-ai-workflow-to-backend': `${base || ''}/blog/ai/ai-guardrails-before-codegen`,
    '/blog/incident/currency-anomaly-detection': `${base || ''}/blog/incident/currency-reclaim`,
    // pay 정답이 있는 문제(버그·표준 적용·측정 교정) 6편을 비공개로 내린다.
    // 남기는 것은 "정답이 없어 골라야 했던" 글뿐이고, 옛 주소는 pay 소개 글로 보낸다.
    '/blog/project/pay/pay-ch1-what-to-trust': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch2-runtime-truths': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch3-money-leaks': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch4-my-docs-were-wrong': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch7-measuring-wrong': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch15-webhook-arrived-first': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    // 동시성 편: 락 3종·적립 4안 실측 비교는 "재면 답이 나오는" 유형이라 내린다.
    '/blog/project/pay/pay-ch2-concurrency-and-load': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
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
    // 2026-09-18 판단이 얕은 세 편을 비공개로 돌렸다. 옛 주소는 관련 글로 보낸다.
    '/blog/daily/what-really-matters': `${base || ''}/about`,
    '/blog/project/wikiengine/search-quality': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/view-count-redis': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    // 2026-09-18 위키엔진 표준 적용 글 11편을 비공개로 돌렸다. 옛 주소는 위키엔진 소개 글로 보낸다.
    '/blog/project/wikiengine/replication': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/scaleout': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/trie-autocomplete': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/caching-strategy': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/search-category-facet': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/search-content-filter': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/search-query-enhancement': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/search-system-crash': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/distributed-stability': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/autocomplete-btree-index': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/wikiengine/nori-stop-filter-fix': `${base || ''}/blog/project/wikiengine/wiki-search-overview`,
    '/blog/project/codingtestkit/codingtestkit-thankful-review': `${base || ''}/blog/project/codingtestkit/codingtestkit-introduction`,
    '/blog/daily/hello-world': `${base || ''}/about`,
    // 2026-09-18 프로젝트 소개 한 편만 남기고 나머지 글을 지웠다. 옛 주소는 소개 글로 보낸다.
    '/blog/project/edumeet/own-hls': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/captions-ahead-of-video': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/limits-i-wrote-down': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/dbtower/dbtower-1-design': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-2-engines-and-diagnosis': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-3-production-safety': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-4-deepening': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-5-productionization': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-6-backup': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-7-multi-tenancy': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-8-talking-and-lakehouse': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-9-operational-bottlenecks': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    '/blog/project/dbtower/dbtower-10-ai-cost-audit': `${base || ''}/blog/project/dbtower/dbtower-0-overview`,
    // 2026-09-20 b-studio 1편을 접었다. 남은 소개 글로 보낸다.
    '/blog/project/b-studio/b-studio-1-dump-streaming-and-path-rules': `${base || ''}/blog/project/b-studio/b-studio-0-intro`,
    // 2026-09-20 lakehouse 연재를 접었다. DBTower 는 그대로 두고, lakehouse 옛 주소만
    // 프로젝트 목록으로 보낸다. (dbtower-8 슬러그에 lakehouse 이름이 들어 있지만 DBTower 편이다.)
    '/blog/project/lakehouse/lakehouse-0-why': `${base || ''}/projects`,
    '/blog/project/lakehouse/lakehouse-1-build': `${base || ''}/projects`,
    '/blog/project/lakehouse/lakehouse-2-trust': `${base || ''}/projects`,
    '/blog/project/lakehouse/lakehouse-3-scale': `${base || ''}/projects`,
    '/blog/project/lakehouse/lakehouse-4-appliance': `${base || ''}/projects`,
    '/blog/project/lakehouse/lakehouse-5-verdicts': `${base || ''}/projects`,
    '/blog/project/lakehouse/lakehouse-6-ash': `${base || ''}/projects`,
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
    '/blog/project/edumeet/egress-cost-model': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/mcp-transcript-server': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/unrunnable-code': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    // 모노레포 합치기·CI 이관·Flyway 가 한 글에 묶여 있어 어느 것도 검색어가 안 됐다.
    // 살릴 사실(git subtree 이력 끊김)은 저장소 docs/ 에 남기고 글은 접었다.
    '/blog/project/edumeet/monorepo-revealed': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    // 셋 다 프로젝트 진행 기록에 가까웠다. 각각에 한 조각씩 쓸 만한 게 있어
    // 지우지 않고 한 편으로 합쳤다(하트비트 · 과금 단위 · 베이스라인).
    '/blog/project/edumeet/reaching-the-screen': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/caption-to-summary': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/measure-before-the-model': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/deploy-and-migration': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/three-questions-measured': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
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
    '/blog/project/edumeet/config-that-does-nothing': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/measuring-on-the-real-server': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/realtime-caption-decisions': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
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
    '/blog/project/edumeet/ops-that-look-installed': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
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
    '/blog/project/edumeet/baseline-before-model': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    '/blog/project/edumeet/alerting-with-measured-thresholds': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    // zero-downtime-deploy 를 접었다 (2026-08-31)
    //
    // ★ 기준 - "해결한 문제가 실재했는가".
    //   사용자가 없는 서비스에서 배포 중단 20.5초는 아무 피해가 아니다.
    //   0으로 만든 것은 "할 수 있다" 의 증명이지 "필요했다" 가 아니다.
    //
    //   다만 그 작업이 실제로 값을 한 순간은 있었다 - Origin 을 고치는 동안
    //   배포가 네 번 실패했는데 서비스가 한 번도 안 끊겼다. 그 한 문단만
    //   captions-ahead-of-video 로 옮겼다.
    '/blog/project/edumeet/zero-downtime-deploy': `${base || ''}/blog/project/edumeet/edumeet-retrospective`,
    // pay 58편 -> 주제별 10편 (2026-08-31)
    //
    // 세 세대에 걸쳐 합쳤는데 리다이렉트를 한 번도 안 남겨서
    // 이미 공유한 링크가 전부 죽어 있었다. 지금까지의 슬러그를 전부 잇는다.
    // 한 글이 여러 편으로 흩어진 경우는 알맹이가 가장 많이 간 곳으로 보낸다.
    '/blog/project/pay/pay-ch10-ruler-then-broken-ruler': `${base || ''}/blog/project/be-commerce/be-commerce-ch10-ruler-first`,
    '/blog/project/pay/pay-ch11-measurement-fooled-me': `${base || ''}/blog/project/be-commerce/be-commerce-ch11-ruler-fooled-me`,
    '/blog/project/pay/pay-ch16-draft-port-number-guard': `${base || ''}/blog/project/be-commerce/be-commerce-ch10-ruler-first`,
    '/blog/project/pay/pay-ch17-model-found-my-bug': `${base || ''}/blog/project/be-commerce/be-commerce-ch10-ruler-first`,
    '/blog/project/pay/pay-ch18-measurement-fooled-me': `${base || ''}/blog/project/be-commerce/be-commerce-ch11-ruler-fooled-me`,
    '/blog/project/pay/pay-ch21-measure-without-demanding': `${base || ''}/blog/project/be-commerce/be-commerce-ch11-ruler-fooled-me`,
    '/blog/project/pay/pay-ch12-finding-blind-spots': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-ch14-timeline-and-rules': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-ch15-cancellation-overwrite': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-ch19-half-a-fix': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-ch20-count-from-outside': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-ch11-password-hashing': `${base || ''}/blog/project/be-commerce/be-commerce-ch6-auth-cost`,
    '/blog/project/pay/pay-ch12-measuring-wrong': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch1-payment-core': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch2-payment-methods': `${base || ''}/blog/project/be-commerce/be-commerce-ch2-failure-design`,
    '/blog/project/pay/pay-ch3-perf-cancel': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch4-arch-events-ops': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch5-runtime-truths': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch6-security-queue': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch7-consume-align-harden': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch8-settlement-pg-webhook': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch9-audit-saga': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-ch10-features-audit': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-0-why-and-modulith': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-1-order-payment-core': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-2-designing-for-failure': `${base || ''}/blog/project/be-commerce/be-commerce-ch2-failure-design`,
    '/blog/project/pay/pay-3-webhooks-and-outbox': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-4-ledger-settlement-reconciliation': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-5-lock-comparison': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-6-operations': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-7-making-it-run': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-8-real-pg-adapter': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-9-multi-pg-routing': `${base || ''}/blog/project/be-commerce/be-commerce-ch2-failure-design`,
    '/blog/project/pay/pay-10-composite-payment': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-11-subscription-dunning': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-12-prepaid-wallet': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-13-virtual-account': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-14-fraud-detection': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-15-field-encryption': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-16-cash-receipt': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-17-load-test-finds-bottleneck': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-18-order-cancel': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-19-compensation-network-cancel': `${base || ''}/blog/project/be-commerce/be-commerce-ch2-failure-design`,
    '/blog/project/pay/pay-20-jwt-removes-bottleneck': `${base || ''}/blog/project/be-commerce/be-commerce-ch6-auth-cost`,
    '/blog/project/pay/pay-22-kafka-event-externalization': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-23-ops-admin': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-24-chaos-testing': `${base || ''}/blog/project/be-commerce/be-commerce-ch2-failure-design`,
    '/blog/project/pay/pay-25-escrow': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-26-persistence-bug': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-27-retrospective': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-28-query-api': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-29-admin-sync-resolve': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-30-maker-checker': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-31-fds-review-queue': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-32-jwt-refresh-revoke': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-33-settlement-file-reconciliation': `${base || ''}/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement`,
    '/blog/project/pay/pay-34-waiting-queue': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-35-envelope-encryption': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-36-overload-control': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-37-deadlock-retry': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-38-kafka-consumer': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-39-settlement-escrow-alignment': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-40-schedulers': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-41-encryption-applied': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-42-security-hardening': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-43-operability': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-44-observability': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-45-settlement-fee-payout': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-46-multi-pg-routing': `${base || ''}/blog/project/be-commerce/be-commerce-ch2-failure-design`,
    '/blog/project/pay/pay-47-webhook-async': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-48-settlement-date-key-bug': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-49-audit-round2': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-50-hardening-verified': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-51-checkout-saga': `${base || ''}/blog/project/be-commerce/be-commerce-ch2-failure-design`,
    '/blog/project/pay/pay-52-subscription-surface': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-53-wallet-payment-method': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-54-read-surfaces-and-earning': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-55-member-domain': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-56-dispute-chargeback': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-57-audit-found-money-bugs': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    // 7편(초록불 점검)을 접었다 (2026-08-31)
    //
    // ★ 기준 - "'왜 아무도 못 봤는가'를 답하는가".
    //   배치 여섯 개 켜보기·안 돌리던 테스트 둘·문서에 없던 표는 "내가 안 켰다"로 끝나
    //   함정 목록이 된다. 검사기가 두 번 헛통과한 것(대상 0개 · 태스크 스킵)만
    //   일반화되는 통찰이라 6편 상황 3으로 옮겼다.
    '/blog/project/pay/pay-ch13-enforcing-the-rule': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    '/blog/project/pay/pay-21-ci-guards-boundaries': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    // 6편에서 인증/해시(상황 1)를 떼어 별도 편으로 세웠다 (2026-08-31)
    '/blog/project/pay/pay-ch5-measuring-performance': `${base || ''}/blog/project/be-commerce/be-commerce-0-overview`,
    // 10편(AI 운영 자동화)을 둘로 나눴다 (2026-08-31)
    '/blog/project/pay/pay-ch9-ai-in-operations': `${base || ''}/blog/project/be-commerce/be-commerce-ch10-ruler-first`,
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
