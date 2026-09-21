import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 같은 요청이 어느 쪽에서 기다리는지만 바뀐다.
const k = canvas(1400, 360);

const bw = 250, bh = 84, gap = 120;
const ax = 205, bx = 575, cx = 945;

const row = (y, pool, poolNote, poolColor, dbNote, dbColor) => {
  box(k, ax, y, bw, bh, { color: C.gray });
  text(k, ax + bw / 2, y + 51, '애플리케이션', { size: 18, weight: 700 });
  box(k, bx, y, bw, bh, { color: poolColor });
  text(k, bx + bw / 2, y + 51, pool, { size: 18, weight: 700, fill: poolColor.s });
  box(k, cx, y, bw, bh, { color: dbColor });
  text(k, cx + bw / 2, y + 51, 'DB', { size: 18, weight: 700, fill: dbColor.s });
  arrow(k, ax + bw + 8, y + bh / 2, bx - 8, y + bh / 2, { color: '#adb5bd' });
  arrow(k, bx + bw + 8, y + bh / 2, cx - 8, y + bh / 2, { color: '#adb5bd' });
  text(k, bx + bw / 2, y + bh + 30, poolNote, { size: 15, weight: 700, fill: poolColor.s });
  text(k, cx + bw / 2, y + bh + 30, dbNote, { size: 15, weight: 700, fill: dbColor.s });
};

row(50, '풀 10', '여기서 기다린다 pending 90', C.red, '여유', C.green);
row(200, '풀 50', '기다리지 않는다', C.green, '여기서 기다린다', C.red);

writeFileSync(process.argv[2], render(k));
