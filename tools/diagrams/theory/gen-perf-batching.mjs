import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 같은 요청을 즉시 처리할 때와 묶어서 처리할 때.
const k = canvas(1400, 420);

box(k, 40, 24, 620, 360, { color: C.blue, fill: false, roughness: 1.05, r: 16 });
text(k, 350, 62, '즉시 처리', { size: 21, weight: 700, fill: C.blue.s });
[0, 1, 2, 3].forEach((i) => {
  const y = 100 + i * 66;
  box(k, 80, y, 150, 46, { color: C.gray, r: 8 });
  text(k, 155, y + 30, `요청 ${i + 1}`, { size: 15, weight: 600, fill: C.gray.s });
  box(k, 400, y, 150, 46, { color: C.orange, r: 8 });
  text(k, 475, y + 30, 'DB', { size: 15, weight: 700, fill: C.orange.s });
  arrow(k, 236, y + 23, 394, y + 23, { color: '#adb5bd' });
});

box(k, 740, 24, 620, 360, { color: C.green, fill: false, roughness: 1.05, r: 16 });
text(k, 1050, 62, '묶어서 처리', { size: 21, weight: 700, fill: C.green.s });
[0, 1, 2, 3].forEach((i) => {
  const y = 100 + i * 50;
  box(k, 780, y, 150, 38, { color: C.gray, r: 8 });
  text(k, 855, y + 25, `요청 ${i + 1}`, { size: 14, weight: 600, fill: C.gray.s });
  arrow(k, 936, y + 19, 990, 248, { color: '#adb5bd' });
});
box(k, 990, 222, 150, 52, { color: C.green, r: 8 });
text(k, 1065, 254, 'Batch', { size: 16, weight: 700, fill: C.green.s });
box(k, 1200, 222, 120, 52, { color: C.orange, r: 8 });
text(k, 1260, 254, 'DB 1회', { size: 15, weight: 700, fill: C.orange.s });
arrow(k, 1146, 248, 1194, 248, { color: '#adb5bd' });
text(k, 1050, 348, '첫 요청은 batch가 만들어질 때까지 기다린다', { size: 14, weight: 600, fill: C.green.s });

writeFileSync(process.argv[2], render(k));
