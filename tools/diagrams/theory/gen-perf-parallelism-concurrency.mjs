import { canvas, box, text, line, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// Parallelism(같은 순간에 실행)과 Concurrency(번갈아 진행)를 나란히 둔다.
const k = canvas(1400, 480);

const panel = (x, w, title, sub, lanes, axisNote) => {
  box(k, x, 24, w, 400, { color: C.gray, fill: false, roughness: 1.05, r: 16 });
  text(k, x + w / 2, 62, title, { size: 22, weight: 700, fill: C.blue.s });
  text(k, x + w / 2, 88, sub, { size: 14, weight: 500, fill: '#868e96' });
  lanes.forEach((lane, i) => {
    const y = 120 + i * 66;
    text(k, x + 24, y + 26, lane.label, { size: 14, weight: 600, fill: '#495057', anchor: 'start' });
    lane.bars.forEach(([bx, bw]) => {
      box(k, x + bx, y, bw, 36, { color: lane.color, r: 8 });
      if (bw >= 90) text(k, x + bx + bw / 2, y + 24, lane.task, { size: 14, weight: 700, fill: lane.color.s });
    });
  });
  line(k, x + 24, 390, x + w - 24, 390, { color: '#adb5bd', width: 1.6 });
  arrow(k, x + w - 60, 390, x + w - 24, 390, { color: '#adb5bd' });
  text(k, x + w - 30, 418, axisNote, { size: 13, weight: 600, fill: '#868e96', anchor: 'end' });
};

panel(30, 640, 'Parallelism', '여러 작업이 같은 순간에 실행된다',
  [1, 2, 3, 4].map((n, i) => ({
    label: `Core ${n}`,
    task: `Task ${'ABCD'[i]}`,
    color: C.blue,
    bars: [[120, 460]],
  })), '시간');

panel(730, 640, 'Concurrency', '한 순간에는 하나지만 진행 중이다',
  [
    { label: 'Task A', task: 'A', color: C.green, bars: [[120, 110], [400, 120]] },
    { label: 'Task B', task: 'B', color: C.green, bars: [[260, 120], [520, 80]] },
    { label: 'Task C', task: 'C', color: C.green, bars: [[380, 120]] },
  ], '시간');

writeFileSync(process.argv[2], render(k));
