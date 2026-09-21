import { canvas, box, text, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// CPU가 일하고 있는 것과, CPU를 원하는 작업이 줄을 서는 것은 다르다.
const k = canvas(1300, 440);

box(k, 40, 24, 1220, 186, { color: C.blue, fill: false, roughness: 1.05, r: 16 });
text(k, 650, 62, '실행 중', { size: 20, weight: 700, fill: C.blue.s });
['Task A', 'Task B', 'Task C', 'Task D'].forEach((t, i) => {
  const x = 76 + i * 290;
  box(k, x, 96, 270, 72, { color: C.green, r: 10 });
  text(k, x + 135, 140, t, { size: 17, weight: 700, fill: C.green.s });
});

box(k, 40, 240, 1220, 176, { color: C.red, fill: false, roughness: 1.05, r: 16 });
text(k, 650, 278, '대기 중 — CPU를 원하지만 아직 못 받은 작업', { size: 20, weight: 700, fill: C.red.s });
['Task E', 'Task F', 'Task G', 'Task H', 'Task I'].forEach((t, i) => {
  const x = 76 + i * 220;
  box(k, x, 310, 200, 68, { color: C.red, r: 10 });
  text(k, x + 100, 352, t, { size: 16, weight: 700, fill: C.red.s });
});

writeFileSync(process.argv[2], render(k));
