import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 캐시에서 꺼낸 값도 공짜로 도착하지 않는다.
const k = canvas(1400, 250);

const steps = ['Redis GET', 'Network Transfer', 'Decompression', 'Deserialization', 'Java Object'];
const w = 236, gap = 40, y = 90, h = 74;
steps.forEach((t, i) => {
  const x = 30 + i * (w + gap);
  const color = i === 0 ? C.blue : (i === 4 ? C.green : C.gray);
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 46, t, { size: 16, weight: 700, fill: color.s });
  if (i < steps.length - 1) arrow(k, x + w + 6, y + h / 2, x + w + gap - 6, y + h / 2, { color: '#adb5bd' });
});

writeFileSync(process.argv[2], render(k));
