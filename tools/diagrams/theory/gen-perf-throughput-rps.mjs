import { canvas, box, text, line, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 1초 동안 다섯 건이 지나갔다.
const k = canvas(1200, 280);

const x0 = 90, x1 = 1010, y = 120;
line(k, x0, y, x1, y, { color: '#868e96', width: 2 });
line(k, x0, y - 16, x0, y + 16, { color: '#868e96', width: 2 });
line(k, x1, y - 16, x1, y + 16, { color: '#868e96', width: 2 });

for (let i = 0; i < 5; i++) {
  const x = x0 + 60 + i * 190;
  box(k, x, y - 46, 120, 44, { color: C.blue, r: 8 });
  text(k, x + 60, y - 17, '요청', { size: 15, weight: 700, fill: C.blue.s });
}

text(k, (x0 + x1) / 2, y + 52, '1초', { size: 18, weight: 700, fill: '#495057' });

box(k, x1 + 40, y - 46, 130, 44, { color: C.green, r: 8 });
text(k, x1 + 105, y - 17, '5 RPS', { size: 16, weight: 700, fill: C.green.s });

writeFileSync(process.argv[2], render(k));
