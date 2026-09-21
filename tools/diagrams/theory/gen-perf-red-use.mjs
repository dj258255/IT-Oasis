import { canvas, box, frame, text, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 서비스에서 보는 세 가지와 자원에서 보는 세 가지.
const k = canvas(1400, 360);

const panel = (x, color, heading, items) => {
  frame(k, x, 30, 640, 300, { color });
  text(k, x + 320, 70, heading, { size: 21, weight: 700, fill: color.s });
  items.forEach(([t, d, c], i) => {
    const y = 100 + i * 78;
    box(k, x + 40, y, 560, 64, { color: c });
    text(k, x + 72, y + 40, t, { size: 18, weight: 700, fill: c.s, anchor: 'start' });
    text(k, x + 560, y + 40, d, { size: 15, weight: 500, anchor: 'end' });
  });
};

panel(40, C.blue, 'SERVICE · RED', [
  ['Rate', '요청이 얼마나 들어오는가 · RPS', C.blue],
  ['Errors', '오류가 얼마나 나는가 · 5xx', C.red],
  ['Duration', '요청이 얼마나 오래 걸리는가 · p50 / p95 / p99', C.orange],
]);
panel(720, C.purple, 'RESOURCE · USE', [
  ['Utilization', '얼마나 쓰이고 있는가', C.blue],
  ['Saturation', '쓰려는 작업이 줄을 서는가', C.red],
  ['Errors', '오류가 나는가', C.orange],
]);

writeFileSync(process.argv[2], render(k));
