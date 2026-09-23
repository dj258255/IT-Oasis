#!/usr/bin/env node
/**
 * 빌드 결과(dist)의 내부 링크가 실제 페이지를 가리키는지 검사한다.
 *
 * 왜 필요한가
 * -----------
 * 링크는 조용히 깨진다. 빌드도 타입체크도 안 본다. 읽는 사람만 404 를 만난다.
 *
 * 실제로 세 가지가 동시에 죽어 있었다.
 *  - 태그 19개: 태그 페이지는 공개 글로만 만드는데(getPublishedPosts), 글 페이지는 unlisted 글도
 *    만들면서 그 태그를 링크로 그렸다
 *  - 카테고리 `portfolio`: 같은 이유
 *  - `/blog/incident/currency-anomaly-detection`: 리다이렉트 목적지가 draft 로 내려가 사라졌다
 *
 * macOS 에서는 파일 시스템이 대소문자를 구분하지 않아 `/tags/B-Tree` 와 `/tags/B-tree` 가
 * 같은 디렉터리로 보인다. CI(리눅스)에서는 갈린다. 그래서 이 검사는 CI 에서 돌아야 의미가 있다.
 *
 * 사용
 * ----
 *     CI=true pnpm run build && node scripts/check-links.mjs dist
 *
 * **`CI=true` 를 빼면 이 검사는 운영과 다른 것을 본다.** 운영 빌드에만 base(`/IT-Oasis`)가
 * 붙는데, 처음에 그걸 안 맞춰서 로컬 0건 / CI 440건이 나왔다.
 *
 * 깨진 링크나 base 누락이 하나라도 있으면 종료 코드 1.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';

const DIST = process.argv[2] || 'dist';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.html')) out.push(p);
  }
  return out;
}

const files = walk(DIST);

// 페이지 하나 = index.html 하나. 그 부모 경로가 곧 URL 이다.
const rawPages = new Set(['/']);
for (const f of files) {
  if (basename(f) === 'index.html') {
    const url = '/' + relative(DIST, dirname(f)).split('\\').join('/');
    rawPages.add(url === '/.' ? '/' : url.replace(/\/$/, ''));
  }
}

// base 를 빌드 결과에서 알아낸다.
//
// **이걸 틀리면 검사 전체가 거짓말을 한다.** Astro 는 `base` 를 줘도 dist 를 그 이름으로 감싸지
// 않는다 — 디스크는 `dist/tags/…` 인데 링크는 `/IT-Oasis/tags/…` 로 나간다. 처음엔 dist 경로에서
// base 를 추측했다가, 로컬(base 없음)에서는 0건이고 CI(base 있음)에서는 440건이 나왔다.
//
// 앵커는 `_astro` 다. Astro 가 항상 그 이름으로 자산을 내보내므로, 자산 링크에서 `/_astro/` 앞이
// 곧 base 다.
function detectBase() {
  for (const f of files) {
    const m = readFileSync(f, 'utf8').match(/(?:href|src)="(\/[^"]*?)\/_astro\//);
    if (m) return m[1];
  }
  return '';
}
const base = detectBase();

// 링크에는 base 가 붙어 있으므로 페이지 쪽에도 붙여 같은 축으로 비교한다.
const pages = new Set([...rawPages].map((p) => (p === '/' ? base || '/' : `${base}${p}`)));

// 대소문자만 다른 페이지를 찾기 위한 색인. macOS 는 파일 시스템이 대소문자를 안 가려
// 두 페이지가 한 디렉터리로 합쳐진다 — 리눅스에서는 둘 다 생기므로 실패로 볼 수 없다.
const lowered = new Map();
for (const p of pages) lowered.set(p.toLowerCase(), p);

const broken = new Map();
const caseOnly = new Map();
for (const f of files) {
  // 스크립트 안의 템플릿 문자열은 서버가 만든 링크가 아니다. 다만 `${...}` 가 남아 있으면
  // 그건 클라이언트가 만드는 링크이고, base 가 빠져 있어도 여기서는 안 보인다 — 아래에서 따로 본다.
  const html = readFileSync(f, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');
  for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
    const target = decodeURIComponent(m[1]).replace(/\/$/, '') || '/';
    // 파일을 직접 가리키는 링크(.svg·.png·.xml 등)와 업로드 자산은 페이지가 아니다.
    if (target.startsWith(`${base}/uploads`) || /\.[a-z0-9]{2,5}$/i.test(basename(target))) continue;
    if (pages.has(target)) continue;
    const bucket = lowered.has(target.toLowerCase()) ? caseOnly : broken;
    if (!bucket.has(target)) bucket.set(target, new Set());
    bucket.get(target).add(relative(DIST, f));
  }
}

// 클라이언트가 만드는 링크는 base 가 빠지기 쉽다. 검색 결과가 실제로 그래서 전부 404 였다.
const missingBase = new Map();
if (base) {
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/href="(\/(?:blog|tags|categories|projects|about|search)[^"]*)"/g)) {
      if (m[1].startsWith(base)) continue;
      if (!missingBase.has(m[1])) missingBase.set(m[1], new Set());
      missingBase.get(m[1]).add(relative(DIST, f));
    }
  }
}

function report(map, label) {
  for (const [target, sources] of [...map].sort()) {
    const from = [...sources].sort();
    console.log(`${label} ${target}`);
    console.log(`  ← ${from.slice(0, 3).join(', ')}${from.length > 3 ? ` 외 ${from.length - 3}곳` : ''}`);
  }
}

report(broken, '깨진 링크');
report(missingBase, `base(${base}) 빠진 링크`);
report(caseOnly, '경고 — 대소문자만 다름(리눅스에서는 둘 다 생긴다)');

const fail = broken.size + missingBase.size;
console.log(`페이지 ${pages.size}개 · 깨진 링크 ${broken.size}종 · base 누락 ${missingBase.size}종 · 대소문자 경고 ${caseOnly.size}종`);
process.exit(fail ? 1 : 0);
