import { canvas, box, text, line, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// API latency 1,800ms 를 자리별로 쪼갠다.
const k = canvas(1200, 280);

const total = 1800, x0 = 60, width = 1080;
const parts = [
  ['커넥션 대기', 900, C.red],
  ['SQL', 600, C.orange],
  ['애플리케이션', 300, C.blue],
];

let cursor = x0;
parts.forEach(([label, ms, color]) => {
  const w = Math.round(width * ms / total);
  box(k, cursor, 90, w, 70, { color, r: 8 });
  text(k, cursor + w / 2, 132, `${label} ${ms}ms`, { size: 15, weight: 700, fill: color.s });
  cursor += w;
});

line(k, x0, 176, x0, 196, { color: C.purple.s, width: 1.8 });
line(k, x0 + width, 176, x0 + width, 196, { color: C.purple.s, width: 1.8 });
line(k, x0, 186, x0 + width, 186, { color: C.purple.s, width: 1.8 });
text(k, x0 + width / 2, 226, 'API latency 1,800ms', { size: 17, weight: 700, fill: C.purple.s });

writeFileSync(process.argv[2], render(k));
