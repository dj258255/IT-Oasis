import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 풀을 키우면 DB 로 가는 동시 쿼리 수도 함께 는다.
const k = canvas(1200, 320);

const row = (y, pool, note, noteColor) => {
  box(k, 60, y, 200, 74, { color: C.blue, r: 10 });
  text(k, 160, y + 45, pool, { size: 17, weight: 700, fill: C.blue.s });

  box(k, 480, y, 220, 74, { color: noteColor, r: 10 });
  text(k, 590, y + 45, note, { size: 17, weight: 700, fill: noteColor.s });

  box(k, 900, y, 200, 74, { color: C.orange, r: 10 });
  text(k, 1000, y + 45, 'DB', { size: 17, weight: 700, fill: C.orange.s });

  arrow(k, 266, y + 37, 474, y + 37, { color: '#adb5bd' });
  arrow(k, 706, y + 37, 894, y + 37, { color: '#adb5bd' });
};

row(40, '풀 10', '동시 10 쿼리', C.green);
row(190, '풀 50', '동시 50 쿼리', C.red);

writeFileSync(process.argv[2], render(k));
