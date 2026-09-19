import { canvas, text, divider, C } from '../diagrams/draw.mjs';

// 커버 규격. 1200x630 은 PostCard 의 aspect-[40/21](=1.9047) 과 정확히 맞고
// OG 표준 1.91:1 과도 같다. 바꾸면 카드에서 크롭되거나 OG 미리보기가 잘린다.
export const W = 1200;
export const H = 630;
export const PAD = 72;

export const INK = '#212529';
export const MUTED = '#868e96';
export const SOFT = '#495057';
export const FAINT = '#adb5bd';

/**
 * 글자 폭을 센다. 빌드에 캔버스가 없어 실제 측정이 불가능하므로 보수적으로 잡는다.
 * 한글은 전각(1.0em)으로 보고, 라틴·숫자·공백은 그보다 좁게 본다.
 */
export function measure(str, size) {
  let w = 0;
  for (const ch of str) {
    if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/.test(ch)) w += size * 1.02;
    else if (ch === ' ') w += size * 0.30;
    else if (/[0-9]/.test(ch)) w += size * 0.60;
    else if (/[A-Z]/.test(ch)) w += size * 0.70;
    else w += size * 0.55;
  }
  return w;
}

const overflow = [];
export function takeOverflow() {
  const o = [...overflow];
  overflow.length = 0;
  return o;
}

/** 폭을 넘으면 기록하고 그린다. 넘친 글자가 조용히 상자 밖으로 나가는 걸 막는다. */
export function fit(k, x, y, str, size, maxWidth, opts = {}) {
  const w = measure(str, size);
  if (w > maxWidth) warn(`글자 넘침: "${str}" ${Math.round(w)}px > ${maxWidth}px (size ${size})`);
  text(k, x, y, str, { size, ...opts });
  return w;
}

function warn(msg) {
  overflow.push(msg);
}

/**
 * 레이아웃 3종. 제목 크기와 모티프가 들어갈 자리만 정한다.
 * 같은 카테고리 안에서도 레이아웃을 섞어 커버가 한 템플릿으로 보이지 않게 한다.
 */
export const LAYOUTS = {
  // 좌측 텍스트 + 우측 도식. 제목이 짧고 도식이 정방형일 때.
  'right-diagram': { titleSize: 38, column: 544, area: () => ({ x: 656, y: 132, w: 472, h: 388 }) },
  // 상단 제목 전폭 + 하단 가로 밴드. 파이프라인·흐름처럼 가로로 긴 도식.
  'bottom-band': { titleSize: 46, column: W - PAD * 2, area: () => ({ x: PAD, y: 330, w: W - PAD * 2, h: 196 }) },
  // 상단 제목 + 하단 카드 2장. 대조가 글의 뼈대일 때.
  'two-cards': { titleSize: 46, column: W - PAD * 2, area: () => ({ x: PAD, y: 330, w: W - PAD * 2, h: 196 }) },
};

function drawHeader(k, spec, accent) {
  const L = LAYOUTS[spec.layout];
  const size = L.titleSize;
  const step = size * 1.2;

  fit(k, PAD, 92, spec.kicker, 14, 420, { weight: 700, fill: accent.s, anchor: 'start' });
  divider(k, PAD, PAD + Math.max(140, measure(spec.kicker, 14) + 24), 108, { color: accent.s });

  spec.title.forEach((lineText, i) => {
    fit(k, PAD, 176 + i * step, lineText, size, L.column, { weight: 800, fill: INK, anchor: 'start' });
  });

  const lastBaseline = 176 + (spec.title.length - 1) * step;
  fit(k, PAD, lastBaseline + 58, spec.thesis, 17, L.column, { weight: 500, fill: MUTED, anchor: 'start' });
}

function drawFooter(k, spec, accent) {
  divider(k, PAD, W - PAD, H - 74, { color: '#dee2e6' });
  fit(k, PAD, H - 44, spec.footer || 'IT Oasis', 13, 280, { weight: 500, fill: FAINT, anchor: 'start' });
  if (spec.note) fit(k, W - PAD, H - 44, spec.note, 13, 660, { weight: 600, fill: accent.s, anchor: 'end' });
}

/** 스펙 하나를 1200x630 커버로 그린다. motif 는 motifs.mjs 의 함수. */
export function compose(spec, motif) {
  const k = canvas(W, H);
  const accent = C[spec.accent] || C.blue;
  drawHeader(k, spec, accent);
  motif(k, LAYOUTS[spec.layout].area(), spec, accent);
  drawFooter(k, spec, accent);
  return k;
}
