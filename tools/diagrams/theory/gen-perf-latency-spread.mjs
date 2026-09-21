import { canvas, box, text, line, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 요청 8건의 응답 시간. 하나만 튀고 나머지는 낮다.
const k = canvas(1400, 380);

const samples = [20, 21, 22, 20, 23, 24, 21, 900];
const max = 900, top = 60, baseY = 300, maxH = 220;
const w = 110, gap = 46;

samples.forEach((ms, i) => {
  const x = 80 + i * (w + gap);
  const h = Math.max(6, Math.round(maxH * ms / max));
  box(k, x, baseY - h, w, h, { color: ms === max ? C.red : C.gray, r: 6 });
  text(k, x + w / 2, baseY + 30, `${ms}ms`, { size: 14, weight: 700, fill: ms === max ? C.red.s : '#495057' });
});

// 평균선 — 낮은 값들이 평균을 끌어내린다
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
const meanY = baseY - Math.round(maxH * mean / max);
line(k, 60, meanY, 1360, meanY, { color: C.green.s, width: 1.6, roughness: 0.5 });
text(k, 1360, meanY - 12, '평균', { size: 14, weight: 700, fill: C.green.s, anchor: 'end' });

writeFileSync(process.argv[2], render(k));
