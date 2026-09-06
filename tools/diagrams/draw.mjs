import { JSDOM } from 'jsdom';
import rough from 'roughjs';

const dom = new JSDOM('<!DOCTYPE html><body></body>');
const doc = dom.window.document;
const SVGNS = 'http://www.w3.org/2000/svg';

// 엑스칼리드로우 팔레트 — 손그림 도형에 파스텔 hachure, 글자는 읽히는 일반 한글 폰트.
// 손글씨 폰트는 한글을 지원하는 것이 마땅치 않고, 그림이 손그림이면 글자는 또렷한 편이 낫다.
export const C = {
  purple: { s: '#6741d9', f: '#e5dbff' },
  blue:   { s: '#1971c2', f: '#d0ebff' },
  green:  { s: '#2f9e44', f: '#d3f9d8' },
  orange: { s: '#e8590c', f: '#ffe8cc' },
  red:    { s: '#e03131', f: '#ffe3e3' },
  gray:   { s: '#495057', f: '#f1f3f5' },
  yellow: { s: '#f08c00', f: '#fff9db' },
};
const FONT = "'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif";

export function canvas(w, h) {
  const svg = doc.createElementNS(SVGNS, 'svg');
  svg.setAttribute('xmlns', SVGNS);
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('font-family', FONT);
  const bg = doc.createElementNS(SVGNS, 'rect');
  bg.setAttribute('width', w); bg.setAttribute('height', h); bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);
  const rc = rough.svg(svg, { options: { seed: 7 } });   // seed 고정 — 다시 만들어도 같은 그림
  return { svg, rc, w, h };
}

const add = (k, node) => k.svg.appendChild(node);

/** 둥근 모서리 경로. rough.js 의 rectangle 은 각진 것만 그려서 직접 만든다 —
 *  엑스칼리드로우와 제일 크게 갈리는 지점이 모서리다. */
function roundedPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r}`
       + ` L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h}`
       + ` L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r}`
       + ` L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
}

const seedOf = (x, y) => Math.abs(Math.round(x * 31 + y * 17)) % 9999 + 1;

/** 스케치 사각형(둥근 모서리 + 파스텔 hachure 채움). */
export function box(k, x, y, w, h, { color = C.gray, fill = true, roughness = 1.25, r = 14 } = {}) {
  add(k, k.rc.path(roundedPath(x, y, w, h, r), {
    stroke: color.s, strokeWidth: 1.7, roughness,
    fill: fill ? color.f : undefined, fillStyle: 'hachure', hachureGap: 5.5, fillWeight: 1.1,
    seed: seedOf(x, y),
  }));
}

/** 얇은 테두리만 있는 묶음 상자 — 당근 그림의 바깥 프레임 역할. */
export function frame(k, x, y, w, h, { color = C.purple, r = 18 } = {}) {
  add(k, k.rc.path(roundedPath(x, y, w, h, r), {
    stroke: color.s, strokeWidth: 1.5, roughness: 1.1, fill: undefined, seed: seedOf(y, x),
  }));
}

export function text(k, x, y, str, { size = 16, weight = 500, fill = '#212529', anchor = 'middle' } = {}) {
  const t = doc.createElementNS(SVGNS, 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  t.setAttribute('font-size', size); t.setAttribute('font-weight', weight);
  t.setAttribute('fill', fill); t.setAttribute('text-anchor', anchor);
  t.textContent = str;
  add(k, t);
}

/** 상자 안 여러 줄. 줄 수에 맞춰 세로 가운데를 맞춘다. */
export function lines(k, cx, cy, arr, { size = 16, gap = 22, weight = 500, fill = '#212529' } = {}) {
  const top = cy - ((arr.length - 1) * gap) / 2;
  arr.forEach((l, i) => text(k, cx, top + i * gap + size * 0.35, l, { size, weight, fill }));
}

/** 화살표. 머리는 두 획으로 그려 손그림 느낌을 맞춘다. */
export function arrow(k, x1, y1, x2, y2, { color = '#343a40', roughness = 0.9, head = 9 } = {}) {
  const seed = Math.abs(Math.round(x1 * 7 + y2 * 11)) % 9999 + 1;
  add(k, k.rc.line(x1, y1, x2, y2, { stroke: color, strokeWidth: 1.6, roughness, seed }));
  const a = Math.atan2(y2 - y1, x2 - x1), s = 0.42;
  add(k, k.rc.line(x2, y2, x2 - head * Math.cos(a - s), y2 - head * Math.sin(a - s), { stroke: color, strokeWidth: 1.6, roughness, seed }));
  add(k, k.rc.line(x2, y2, x2 - head * Math.cos(a + s), y2 - head * Math.sin(a + s), { stroke: color, strokeWidth: 1.6, roughness, seed }));
}

/** ㄱ자 화살표 — 세로로 내려갔다 가로로 가는 연결. */
export function elbow(k, x1, y1, x2, y2, opts = {}) {
  const midX = x1 + (x2 - x1) / 2;
  const seed = Math.abs(Math.round(x1 * 3 + y1 * 5)) % 9999 + 1;
  const o = { stroke: opts.color || '#343a40', strokeWidth: 1.6, roughness: 0.9, seed };
  add(k, k.rc.line(x1, y1, midX, y1, o));
  add(k, k.rc.line(midX, y1, midX, y2, o));
  arrow(k, midX, y2, x2, y2, opts);
}

/** 제목 뒤 형광펜 자국. 글자 위에 겹치지 않게 <b>먼저</b> 그린다. */
export function marker(k, cx, y, w, { color = C.purple } = {}) {
  add(k, k.rc.path(roundedPath(cx - w / 2, y - 22, w, 30, 6), {
    stroke: 'none', fill: color.f, fillStyle: 'solid', roughness: 2.6, seed: 42,
  }));
}

export function render(k) {
  // rough.js 는 경로 좌표를 소수점 열몇 자리로 뽑는다. 그림에는 아무 차이가 없는데
  // 파일이 두 배가 된다 — SVG 한 장이 200KB 면 열 장에 2MB 다. 한 자리로 줄인다.
  const body = k.svg.outerHTML.replace(/(\d+\.\d{2,})/g, (m) => (+m).toFixed(1));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + body;
}
