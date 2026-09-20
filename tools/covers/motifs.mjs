import { box, text, arrow, pill, line, dot, route, C } from '../diagrams/draw.mjs';
import { fit, INK, MUTED, SOFT } from './compose.mjs';

/**
 * 모티프는 (k, a, spec, accent) 를 받아 a 안에만 그린다.
 * a = { x, y, w, h } — 레이아웃이 정해 준 자리.
 * 글자는 전부 fit() 으로 그려서 상자 밖으로 나가면 빌드가 경고를 남긴다.
 *
 * 카드 폭 380px 에서 보이므로 요소를 크고 적게, 선을 굵게 잡는다.
 * 색은 뜻으로 쓴다: 초록 = 통과·정상, 파랑 = 처리, 빨강 = 거부·사고, 회색 = 곁가지.
 */

const LINK = '#adb5bd';

/** 좌상단 제목 + 본문 줄로 이루어진 카드 하나. 내용은 세로 가운데에 놓는다. */
function card(k, x, y, w, h, color, title, rows) {
  const rowGap = 32;
  const top = y + (h - (30 + rows.length * rowGap)) / 2 + 8;
  box(k, x, y, w, h, { color });
  fit(k, x + 26, top, title, 16, w - 52, { weight: 700, fill: color.s, anchor: 'start' });
  rows.forEach((row, i) => {
    fit(k, x + 26, top + 36 + i * rowGap, row, 15, w - 52, { weight: 500, fill: SOFT, anchor: 'start' });
  });
}

/** 코드와 스키마가 어긋난 두 자리를 좌우로 맞세운다. */
export function schemaMismatch(k, a, spec, accent) {
  const gap = 64;
  const cw = (a.w - gap) / 2;
  const L = spec.labels;
  card(k, a.x, a.y, cw, a.h, C.green, L.left.title, L.left.rows);
  card(k, a.x + cw + gap, a.y, cw, a.h, C.red, L.right.title, L.right.rows);
  text(k, a.x + cw + gap / 2, a.y + a.h / 2 + 11, '≠', { size: 34, weight: 700, fill: C.red.s });
}

/** 쓰기 → 로그 → 캡처 → 브로커 → 읽기 모델. 가로 파이프라인. */
export function cdcPipeline(k, a, spec, accent) {
  const stages = spec.labels.stages;
  const n = stages.length;
  const gap = 46;
  const bw = (a.w - (n - 1) * gap) / n;
  const bh = 104;
  const by = a.y + 26;

  stages.forEach((st, i) => {
    const x = a.x + i * (bw + gap);
    const col = C[st.c] || C.blue;
    box(k, x, by, bw, bh, { color: col });
    fit(k, x + bw / 2, by + 46, st.t, 17, bw - 24, { weight: 700, fill: col.s });
    fit(k, x + bw / 2, by + 76, st.s, 14, bw - 24, { weight: 500, fill: MUTED });
    if (i < n - 1) arrow(k, x + bw + 5, by + bh / 2, x + bw + gap - 5, by + bh / 2, { color: LINK, width: 1.8, head: 10 });
  });

  if (spec.labels.caption) {
    fit(k, a.x + a.w / 2, a.y + a.h - 6, spec.labels.caption, 15, a.w, { weight: 700, fill: accent.s });
  }
}

/** 무엇을 고정하고 무엇을 맡길지 나눈 네 자리. 마지막 하나가 예외다. */
export function pipelineRoles(k, a, spec, accent) {
  const roles = spec.labels.roles;
  const n = roles.length;
  const gap = 24;
  const bw = (a.w - (n - 1) * gap) / n;
  const by = a.y + 20;
  const bh = a.h - 32;

  roles.forEach((r, i) => {
    const x = a.x + i * (bw + gap);
    const col = C[r.c] || C.blue;
    const top = by + (bh - (34 + r.rows.length * 30)) / 2 + 8;
    box(k, x, by, bw, bh, { color: col });
    pill(k, x + bw / 2 - 34, by - 15, 68, 30, { color: col, label: r.tag, size: 13 });
    fit(k, x + bw / 2, top, r.t, 18, bw - 28, { weight: 700, fill: col.s });
    r.rows.forEach((row, j) => {
      fit(k, x + bw / 2, top + 38 + j * 30, row, 14, bw - 28, { weight: 500, fill: SOFT });
    });
  });
}

/** 루트에서 리프로 내려가고, 리프끼리 사슬로 이어진다. 상자 안은 그 노드의 키. */
export function btree(k, a, spec, accent) {
  const L = spec.labels;

  const rw = 210, rh = 62;
  const rx = a.x + (a.w - rw) / 2, ry = a.y + 18;
  box(k, rx, ry, rw, rh, { color: C.purple });
  fit(k, rx + rw / 2, ry + 40, L.root, 20, rw - 24, { weight: 700, fill: C.purple.s });

  const iw = 168, ih = 58, iy = ry + rh + 74;
  [a.x + 14, a.x + a.w - 14 - iw].forEach((x, i) => {
    box(k, x, iy, iw, ih, { color: C.blue });
    fit(k, x + iw / 2, iy + 38, L.internal[i], 20, iw - 20, { weight: 700, fill: C.blue.s });
    arrow(k, rx + rw / 2 + (i === 0 ? -40 : 40), ry + rh + 4, x + iw / 2, iy - 6, { color: LINK, head: 9, width: 1.5 });
  });

  const lw = 138, lh = 54, lgap = 28, ly = iy + ih + 74;
  const lx0 = a.x + (a.w - (3 * lw + 2 * lgap)) / 2;
  for (let i = 0; i < 3; i++) {
    const x = lx0 + i * (lw + lgap);
    box(k, x, ly, lw, lh, { color: C.green });
    fit(k, x + lw / 2, ly + 36, L.leaf[i], 19, lw - 20, { weight: 700, fill: C.green.s });
    if (i < 2) arrow(k, x + lw + 3, ly + lh / 2, x + lw + lgap - 3, ly + lh / 2, { color: C.green.s, head: 8, width: 1.6 });
  }

  if (L.caption) fit(k, a.x + a.w / 2, ly + lh + 38, L.caption, 14, a.w, { weight: 500, fill: MUTED });
}

/** 스레드는 많고 커넥션은 적다. 풀에서 꺼내 다시 쓰는 그림. */
export function poolSaturation(k, a, spec, accent) {
  const L = spec.labels;
  const tw = 138, th = 44, tstep = 66;
  const pw = 206, ph = 300;
  const px = a.x + a.w - pw;
  const py = a.y + 38;

  for (let i = 0; i < 5; i++) {
    const y = a.y + 28 + i * tstep;
    box(k, a.x, y, tw, th, { color: C.gray });
    fit(k, a.x + tw / 2, y + 28, `${L.thread} ${i + 1}`, 14, tw - 16, { weight: 600, fill: SOFT });
    arrow(k, a.x + tw + 10, y + th / 2, px - 10, y + th / 2, { color: LINK, head: 8, width: 1.4 });
  }

  box(k, px, py, pw, ph, { color: C.blue });
  fit(k, px + pw / 2, py + 42, L.pool, 17, pw - 24, { weight: 700, fill: C.blue.s });

  for (let i = 0; i < 3; i++) {
    const y = py + 68 + i * 76;
    box(k, px + 22, y, pw - 44, 52, { color: C.green });
    fit(k, px + pw / 2, y + 32, L.slot, 14, pw - 56, { weight: 600, fill: C.green.s });
  }

  if (L.caption) fit(k, a.x + a.w / 2, a.y + a.h - 6, L.caption, 14, a.w, { weight: 700, fill: accent.s });
}

/** 두 생명선 사이의 3-way 핸드셰이크. 위에서 아래로 SYN, SYN·ACK, ACK. */
export function tcpHandshake(k, a, spec, accent) {
  const L = spec.labels;
  const cxL = a.x + 220, cxR = a.x + a.w - 220;
  const top = a.y + 36, bottom = a.y + a.h - 24;

  line(k, cxL, top, cxL, bottom, { color: LINK, width: 1.8 });
  line(k, cxR, top, cxR, bottom, { color: LINK, width: 1.8 });
  dot(k, cxL, top, 5, { color: C.gray });
  dot(k, cxR, top, 5, { color: C.gray });
  dot(k, cxL, bottom, 5, { color: C.gray });
  dot(k, cxR, bottom, 5, { color: C.gray });

  fit(k, cxL, a.y + 20, L.left, 16, 220, { weight: 700, fill: INK });
  fit(k, cxR, a.y + 20, L.right, 16, 220, { weight: 700, fill: INK });

  L.steps.forEach((st, i) => {
    const y = top + 36 + i * 40;
    const col = C[st.c] || C.blue;
    if (i % 2 === 0) arrow(k, cxL, y, cxR, y, { color: col.s, width: 2, head: 11 });
    else arrow(k, cxR, y, cxL, y, { color: col.s, width: 2, head: 11 });
    fit(k, (cxL + cxR) / 2, y - 13, `${st.t}   ${st.d}`, 15, cxR - cxL - 40, { weight: 700, fill: col.s });
  });
}

/** 상태가 앞으로만 가지 않는다. 완료 뒤에 앞 단계로 돌아오는 전이를 그린다. */
export function stateReversal(k, a, spec, accent) {
  const L = spec.labels;
  const bw = 300, bh = 62, x = a.x + (a.w - bw) / 2;
  const ys = [a.y + 26, a.y + 138, a.y + 250];
  const cols = [C.gray, C.blue, C.green];

  ys.forEach((y, i) => {
    box(k, x, y, bw, bh, { color: cols[i] });
    fit(k, x + bw / 2, y + 40, L.states[i], 18, bw - 24, { weight: 700, fill: cols[i].s });
    if (i < 2) arrow(k, x + bw / 2, y + bh + 4, x + bw / 2, ys[i + 1] - 4, { color: LINK, width: 1.8, head: 10 });
  });

  // 완료에서 입금 대기로 되돌아오는 전이
  const rx = x + bw;
  route(k, [[rx, ys[2] + bh / 2], [rx + 40, ys[2] + bh / 2], [rx + 40, ys[1] + bh / 2], [rx, ys[1] + bh / 2]], { color: C.red.s });
  fit(k, x + bw - 20, ys[1] + bh + 32, L.back, 14, 120, { weight: 700, fill: C.red.s, anchor: 'end' });

  if (L.caption) fit(k, a.x + a.w / 2, a.y + a.h - 6, L.caption, 14, a.w, { weight: 700, fill: accent.s });
}

/** 판정은 나오는데 그 판정이 경로에 붙어 있지 않다. 승인 경로 옆에 판정 상자를 두고 연결이 끊긴 자리를 표시한다. */
export function blockIgnored(k, a, spec, accent) {
  const L = spec.labels;
  const cw = 200, ch = 58, x1 = a.x + 4, x2 = a.x + 262;

  box(k, x1, a.y + 44, cw, ch, { color: C.blue });
  fit(k, x1 + cw / 2, a.y + 80, L.request, 17, cw - 24, { weight: 700, fill: C.blue.s });
  box(k, x1, a.y + 236, cw, ch, { color: C.green });
  fit(k, x1 + cw / 2, a.y + 272, L.approve, 17, cw - 24, { weight: 700, fill: C.green.s });

  arrow(k, x1 + cw / 2, a.y + 106, x1 + cw / 2, a.y + 232, { color: LINK, width: 1.8, head: 10 });
  fit(k, x1 + cw / 2 - 10, a.y + 176, L.path, 14, 120, { weight: 700, fill: MUTED, anchor: 'end' });

  box(k, x2, a.y + 140, 204, ch, { color: C.red });
  fit(k, x2 + 102, a.y + 176, L.judge, 16, 184, { weight: 700, fill: C.red.s });

  // 끊긴 연결: 판정 상자에서 승인 경로로 가려다 만 선
  line(k, x1 + cw + 4, a.y + 169, x1 + cw + 22, a.y + 169, { color: C.red.s, width: 1.6 });
  fit(k, x1 + cw + 26, a.y + 176, '×', 20, 32, { weight: 700, fill: C.red.s, anchor: 'start' });
  fit(k, x2 + 102, a.y + 226, L.note, 13, 204, { weight: 500, fill: MUTED });

  if (L.caption) fit(k, a.x + a.w / 2, a.y + a.h - 6, L.caption, 14, a.w, { weight: 700, fill: accent.s });
}

/** 같은 사건을 두 방식으로 기록한다. 왼쪽은 덮어쓰기, 오른쪽은 따로 쌓기. */
export function overwriteAppend(k, a, spec, accent) {
  const L = spec.labels;
  const gap = 60;
  const cw = (a.w - gap) / 2;
  const cols = [C.red, C.green];
  const sides = [L.before, L.after];

  sides.forEach((side, i) => {
    const x = a.x + i * (cw + gap);
    box(k, x, a.y, cw, a.h, { color: cols[i] });
    fit(k, x + 24, a.y + 46, side.title, 16, cw - 48, { weight: 700, fill: cols[i].s, anchor: 'start' });
    side.rows.forEach((row, j) => {
      fit(k, x + 24, a.y + 92 + j * 34, row, 15, cw - 48, { weight: 500, fill: SOFT, anchor: 'start' });
    });
  });
  fit(k, a.x + cw + gap / 2, a.y + a.h / 2 + 10, '≠', { size: 30, weight: 700, fill: C.red.s });
}

/** 파서가 행을 하나씩 버린다. 들어온 행 중 하나가 빠져나가는 자리를 표시한다. */
export function droppedRow(k, a, spec, accent) {
  const L = spec.labels;
  const rw = 200, rh = 48, gap = 16;
  const x = a.x + 6;
  const ys = [a.y + 26, a.y + 26 + rh + gap, a.y + 26 + (rh + gap) * 2];

  ys.forEach((y, i) => {
    const dropped = i === 1;
    box(k, x, y, rw, rh, { color: dropped ? C.red : C.blue });
    fit(k, x + rw / 2, y + 31, L.rows[i], 15, rw - 24, { weight: 700, fill: (dropped ? C.red : C.blue).s });
    if (dropped) {
      const cx = x + rw + 56;
      fit(k, cx, y + 31, '버림', 14, 90, { weight: 700, fill: C.red.s });
      line(k, x + rw + 8, y + rh / 2, cx - 10, y + rh / 2, { color: C.red.s, width: 1.6 });
    }
  });

  fit(k, x + rw / 2, ys[2] + rh + 44, L.note, 14, a.w - 12, { weight: 500, fill: MUTED });
  if (L.caption) fit(k, a.x + a.w / 2, a.y + a.h - 6, L.caption, 14, a.w, { weight: 700, fill: accent.s });
}

/** 같은 것을 두 곳에 내보낸다. 왼쪽과 오른쪽의 규칙이 다르다. */
export function pairCards(k, a, spec, accent) {
  const L = spec.labels;
  const gap = 60;
  const cw = (a.w - gap) / 2;
  const cols = [C.blue, C.green];

  L.sides.forEach((side, i) => {
    const x = a.x + i * (cw + gap);
    box(k, x, a.y, cw, a.h, { color: cols[i] });
    fit(k, x + 24, a.y + 46, side.title, 16, cw - 48, { weight: 700, fill: cols[i].s, anchor: 'start' });
    side.rows.forEach((row, j) => {
      fit(k, x + 24, a.y + 92 + j * 34, row, 15, cw - 48, { weight: 500, fill: SOFT, anchor: 'start' });
    });
  });
}

/** 두 답을 순서를 바꿔 두 번 묻는다. 심판이 고른 것이 질인지 자리인지 가리는 자리. */
export function orderFlip(k, a, spec, accent) {
  const L = spec.labels;
  const bw = 172, bh = 62;
  const y = a.y + 56;
  const x1 = a.x + 4, x2 = a.x + a.w - bw - 4;

  box(k, x1, y, bw, bh, { color: C.gray });
  fit(k, x1 + bw / 2, y + 38, L.left, 17, bw - 20, { weight: 700, fill: C.gray.s });
  box(k, x2, y, bw, bh, { color: C.blue });
  fit(k, x2 + bw / 2, y + 38, L.right, 17, bw - 20, { weight: 700, fill: C.blue.s });

  arrow(k, x1 + bw + 8, y + bh / 2, x2 - 8, y + bh / 2, { color: LINK, width: 1.8, head: 9 });
  fit(k, a.x + a.w / 2, y - 20, L.ask, 14, a.w, { weight: 600, fill: MUTED });

  const ry = y + bh + 56;
  box(k, a.x + 4, ry, a.w - 8, 78, { color: C.red });
  fit(k, a.x + a.w / 2, ry + 32, L.result, 19, a.w - 40, { weight: 700, fill: C.red.s });
  fit(k, a.x + a.w / 2, ry + 58, L.detail, 13, a.w - 40, { weight: 500, fill: MUTED });

  if (L.caption) fit(k, a.x + a.w / 2, a.y + a.h - 6, L.caption, 14, a.w, { weight: 700, fill: accent.s });
}

export const MOTIFS = {
  'schema-mismatch': schemaMismatch,
  'cdc-pipeline': cdcPipeline,
  'pipeline-roles': pipelineRoles,
  btree,
  'pool-saturation': poolSaturation,
  'tcp-handshake': tcpHandshake,
  'state-reversal': stateReversal,
  'block-ignored': blockIgnored,
  'overwrite-append': overwriteAppend,
  'dropped-row': droppedRow,
  'pair-cards': pairCards,
  'order-flip': orderFlip,
};
