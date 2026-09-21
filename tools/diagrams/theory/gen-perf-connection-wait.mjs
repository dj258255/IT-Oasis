import { canvas, box, text, arrow, line, pill, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 풀이 꽉 차면 뒤의 요청은 커넥션이 반환될 때까지 기다린다.
const k = canvas(1300, 480);

box(k, 60, 170, 200, 70, { color: C.gray });
text(k, 160, 212, '요청 01 ~ 10', { size: 16, weight: 700 });

box(k, 340, 50, 520, 300, { color: C.blue, fill: false, roughness: 1.05, r: 16 });
text(k, 600, 88, '커넥션 풀 (maximum 10)', { size: 18, weight: 700, fill: C.blue.s });
for (let i = 0; i < 10; i++) {
  const x = 366 + (i % 5) * 100;
  const y = 116 + Math.floor(i / 5) * 68;
  box(k, x, y, 88, 52, { color: C.green, r: 8 });
  text(k, x + 44, y + 33, `${i + 1}`.padStart(2, '0'), { size: 15, weight: 700, fill: C.green.s });
}
text(k, 600, 322, '10개 모두 사용 중', { size: 15, weight: 700, fill: C.blue.s });

box(k, 940, 170, 160, 70, { color: C.orange });
text(k, 1020, 212, 'DB', { size: 18, weight: 700, fill: C.orange.s });
arrow(k, 266, 205, 334, 205, { color: '#adb5bd' });
arrow(k, 866, 205, 934, 205, { color: '#adb5bd' });

[0, 1, 2].forEach((i) => {
  const x = 400 + i * 200;
  box(k, x, 392, 170, 56, { color: C.red, r: 10 });
  text(k, x + 85, 426, `요청 1${i + 1}`, { size: 15, weight: 700, fill: C.red.s });
  line(k, x + 85, 388, x + 85, 356, { color: C.red.s, width: 1.6 });
  arrow(k, x + 85, 362, x + 85, 352, { color: C.red.s });
});
pill(k, 1010, 400, 96, 40, { color: C.red, label: '대기', size: 15 });

writeFileSync(process.argv[2], render(k));
