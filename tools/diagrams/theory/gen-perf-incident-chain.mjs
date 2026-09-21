import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 처음 발견한 p95에서 원인 쪽으로 거슬러 올라가는 사슬만 그린다.
const k = canvas(1400, 420);

const bw = 228, bh = 92, gap = 40, y1 = 70, y2 = 250;

const row1 = [
  ['캐시 hit ↓', C.red],
  ['DB QPS ↑', C.orange],
  ['DB 사용률 ↑', C.orange],
  ['DB 포화', C.red],
  ['쿼리 지연 ↑', C.orange],
];
const row2 = [
  ['커넥션 점유 ↑', C.orange],
  ['풀 포화', C.red],
  ['커넥션 대기 ↑', C.orange],
  ['API p95 ↑', C.red],
];

const xs1 = row1.map((_, i) => 60 + i * (bw + gap));
const xs2 = row2.map((_, i) => 1132 - i * (bw + gap));

row1.forEach(([t, c], i) => {
  box(k, xs1[i], y1, bw, bh, { color: c });
  text(k, xs1[i] + bw / 2, y1 + 55, t, { size: 18, weight: 700, fill: c.s });
  if (i < row1.length - 1) arrow(k, xs1[i] + bw + 6, y1 + bh / 2, xs1[i + 1] - 6, y1 + bh / 2, { color: '#adb5bd' });
});
arrow(k, xs1[4] + bw / 2, y1 + bh + 6, xs2[0] + bw / 2, y2 - 6, { color: '#adb5bd' });
row2.forEach(([t, c], i) => {
  box(k, xs2[i], y2, bw, bh, { color: c });
  text(k, xs2[i] + bw / 2, y2 + 55, t, { size: 18, weight: 700, fill: c.s });
  if (i < row2.length - 1) arrow(k, xs2[i] - 6, y2 + bh / 2, xs2[i + 1] + bw + 6, y2 + bh / 2, { color: '#adb5bd' });
});

text(k, xs1[0] + bw / 2, y1 - 22, '원인', { size: 15, weight: 700, fill: C.red.s });
text(k, xs2[3] + bw / 2, y2 + bh + 34, '결과', { size: 15, weight: 700, fill: C.red.s });

writeFileSync(process.argv[2], render(k));
