import { canvas, box, text, lines, line, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 640);

marker(k, 700, 46, 620);
text(k, 700, 46, '오타·어형 쿼리에서 MySQL 셋은 엔진을 따라오지 못했다', { size: 25, weight: 700 });
text(k, 700, 80, '같은 API · 쿼리 545개(seed 7) · 오타·어형 nDCG@10(B·C·E 평균) · 2차 질의 기준 · 로컬 단일 장비', { size: 14, fill: '#868e96' });

const rows = [
  ['like (지금까지)', 0.071, C.red, '1,471ms'],
  ['like-fields', 0.144, C.orange, '848ms'],
  ['MySQL FULLTEXT', 0.324, C.yellow, '205ms'],
  ['Lucene (앱 안)', 0.808, C.green, '30ms'],
  ['Elasticsearch', 0.814, C.blue, '47ms'],
  ['OpenSearch', 0.798, C.blue, '53ms'],
];
const X0 = 250, W = 560;
text(k, X0 + W / 2, 128, 'nDCG@10', { size: 15, weight: 700 });
text(k, 1150, 128, '동시성 10 p95', { size: 15, weight: 700 });
rows.forEach(([label, v, color, p95], i) => {
  const y = 150 + i * 56;
  text(k, X0 - 14, y + 24, label, { size: 15, weight: 600, anchor: 'end' });
  box(k, X0, y, Math.max(16, v * W), 36, { color, r: 8 });
  text(k, X0 + v * W + 12, y + 24, v.toFixed(3), { size: 14.5, weight: 600, anchor: 'start' });
  text(k, 1150, y + 24, p95, { size: 15, weight: 600 });
});
line(k, X0 + 0.324 * W + 0.10 * W, 140, X0 + 0.324 * W + 0.10 * W, 490, { color: C.red.s, width: 1.4 });
text(k, X0 + 0.424 * W, 505, '판정선: MySQL 최선 + 0.10', { size: 13, fill: C.red.s });

box(k, 40, 540, 1320, 80, { color: C.yellow });
lines(k, 700, 580, [
  '엔진 셋의 차이는 0.016 → 측정 전 기준대로 운영 비용으로 골랐다: 앱 안 Lucene(색인 1.4초 · 힙 5MB) 대 컨테이너 약 1GB',
  '1차에서는 오타 허용만 걸어 blazer 가 드문 이웃 lazer 에 밀렸다 → 정확 일치 절을 3배로 더해 다시 쟀다',
], { size: 14.5, gap: 26, weight: 600 });
writeFileSync(process.argv[2], render(k));
