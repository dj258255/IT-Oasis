import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 장애를 볼 때 따라가는 순서만 그린다. 해석은 본문이 맡는다.
const k = canvas(1100, 700);

const center = (y, label, sub, w, color) => {
  const x = 550 - w / 2;
  box(k, x, y, w, sub ? 74 : 58, { color });
  text(k, 550, y + (sub ? 32 : 37), label, { size: 18, weight: 700, fill: color.s });
  if (sub) text(k, 550, y + 58, sub, { size: 14, weight: 500, fill: '#495057' });
};

center(30, '사용자', null, 200, C.gray);
arrow(k, 550, 90, 550, 116, { color: '#adb5bd' });
center(120, 'API가 느리다', null, 260, C.blue);
arrow(k, 550, 180, 550, 200, { color: '#adb5bd' });

// 두 갈래로 갈라졌다가 다시 모인다
arrow(k, 550, 204, 340, 240, { color: '#adb5bd' });
arrow(k, 550, 204, 760, 240, { color: '#adb5bd' });
box(k, 200, 244, 280, 66, { color: C.blue });
text(k, 340, 285, 'Traffic · RPS', { size: 17, weight: 700, fill: C.blue.s });
box(k, 620, 244, 280, 66, { color: C.red });
text(k, 760, 285, 'Errors · 5xx', { size: 17, weight: 700, fill: C.red.s });
arrow(k, 340, 314, 550, 350, { color: '#adb5bd' });
arrow(k, 760, 314, 550, 350, { color: '#adb5bd' });

center(354, 'Latency', 'p50 / p95 / p99', 320, C.orange);
arrow(k, 550, 430, 550, 456, { color: '#adb5bd' });
center(460, '요청은 어디에서 기다리는가?', null, 400, C.purple);
arrow(k, 550, 520, 550, 540, { color: '#adb5bd' });

const lanes = [
  [60, 'CPU', 'util · saturation', C.blue],
  [430, 'DB', 'query · conn wait', C.orange],
  [800, 'Cache', 'hit rate · latency', C.green],
];
arrow(k, 550, 544, 180, 578, { color: '#adb5bd' });
arrow(k, 550, 544, 550, 578, { color: '#adb5bd' });
arrow(k, 550, 544, 920, 578, { color: '#adb5bd' });
lanes.forEach(([x, t, d, c]) => {
  box(k, x, 582, 240, 70, { color: c });
  text(k, x + 120, 612, t, { size: 17, weight: 700, fill: c.s });
  text(k, x + 120, 636, d, { size: 13, weight: 500, fill: '#495057' });
});

text(k, 550, 676, 'Network / Disk', { size: 16, weight: 700, fill: C.gray.s });

writeFileSync(process.argv[2], render(k));
