import { canvas, text, line, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 동시성에 따른 처리량과 지연의 모양만 그린다.
const k = canvas(1200, 560);

const X0 = 140, X1 = 1100, Y0 = 500, Y1 = 90;
line(k, X0, Y1 - 10, X0, Y0, { color: '#868e96', width: 1.8 });
line(k, X0, Y0, X1 + 10, Y0, { color: '#868e96', width: 1.8 });
text(k, X1, 536, '동시성', { size: 15, weight: 700, fill: '#868e96', anchor: 'end' });

// 처리량 — 함께 오르다 무릎 뒤로 평평해진다
const tp = [[140, 480], [280, 390], [400, 300], [500, 250], [600, 220], [760, 200], [1100, 194]];
for (let i = 0; i < tp.length - 1; i++) {
  line(k, tp[i][0], tp[i][1], tp[i + 1][0], tp[i + 1][1], { color: C.blue.s, width: 2.6, roughness: 0.8 });
}
// 지연 — 무릎까지 낮게 유지되다 뒤에서 치솟는다
const lt = [[140, 470], [400, 466], [560, 460], [680, 430], [800, 350], [920, 250], [1040, 165], [1100, 140]];
for (let i = 0; i < lt.length - 1; i++) {
  line(k, lt[i][0], lt[i][1], lt[i + 1][0], lt[i + 1][1], { color: C.red.s, width: 2.6, roughness: 0.8 });
}
line(k, 600, 220, 600, Y0, { color: C.green.s, width: 1.6, roughness: 0.6 });
text(k, 600, 200, '무릎', { size: 15, weight: 700, fill: C.green.s });

text(k, 700, 168, 'Throughput', { size: 16, weight: 700, fill: C.blue.s, anchor: 'start' });
text(k, 1080, 124, 'Latency', { size: 16, weight: 700, fill: C.red.s, anchor: 'end' });

writeFileSync(process.argv[2], render(k));
