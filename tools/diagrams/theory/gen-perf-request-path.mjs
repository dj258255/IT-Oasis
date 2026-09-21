import { canvas, box, text, arrow, line, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 요청 하나가 지나가는 자리. 어디에서 시간이 쓰이는지 묻는 출발점.
const k = canvas(1400, 300);

const stages = [
  ['Client', C.gray],
  ['Controller', C.blue],
  ['Service', C.blue],
  ['Repository', C.blue],
  ['DB', C.orange],
  ['Response', C.green],
];
const w = 176, h = 86, gap = 46, y = 60;
stages.forEach(([t, c], i) => {
  const x = 42 + i * (w + gap);
  box(k, x, y, w, h, { color: c });
  text(k, x + w / 2, y + 51, t, { size: 18, weight: 700, fill: c.s });
  if (i < stages.length - 1) arrow(k, x + w + 6, y + h / 2, x + w + gap - 6, y + h / 2, { color: '#adb5bd' });
});

line(k, 42, 210, 1310, 210, { color: C.purple.s, width: 1.8 });
line(k, 42, 200, 42, 220, { color: C.purple.s, width: 1.8 });
line(k, 1310, 200, 1310, 220, { color: C.purple.s, width: 1.8 });
text(k, 676, 244, '요청 하나의 latency', { size: 16, weight: 700, fill: C.purple.s });

writeFileSync(process.argv[2], render(k));
