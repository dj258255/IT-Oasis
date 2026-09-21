import { canvas, box, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 200 OK 는 처리됐다는 뜻일 뿐, 기록이 남았다는 뜻은 아니다.
const k = canvas(1300, 300);

const row = (y, last, lastColor) => {
  const w = 220, h = 70, gap = 90;
  const x0 = 60;
  ['POST /payments', '서버', '200 OK'].forEach((t, i) => {
    const x = x0 + i * (w + gap);
    box(k, x, y, w, h, { color: i === 2 ? C.green : C.blue });
    text(k, x + w / 2, y + 44, t, { size: 17, weight: 700, fill: (i === 2 ? C.green : C.blue).s });
    if (i < 2) arrow(k, x + w + 10, y + h / 2, x + w + gap - 10, y + h / 2, { color: '#adb5bd' });
  });
  const x = x0 + 3 * (w + gap);
  box(k, x, y, 300, h, { color: lastColor });
  text(k, x + 150, y + 44, last, { size: 17, weight: 700, fill: lastColor.s });
  arrow(k, x0 + 2 * (w + gap) + w + 10, y + h / 2, x - 10, y + h / 2, { color: '#adb5bd' });
};

row(50, '승인 기록 있음', C.green);
row(180, '승인 기록 누락', C.red);

writeFileSync(process.argv[2], render(k));
