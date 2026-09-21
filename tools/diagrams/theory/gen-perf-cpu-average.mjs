import { canvas, box, text, line, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 5분 평균 70%가 짧은 burst의 100%를 가린다.
const k = canvas(1200, 440);

const X0 = 140, X1 = 1090, Y0 = 380, YTOP = 80;
line(k, X0, YTOP - 20, X0, Y0, { color: '#868e96', width: 1.8 });
line(k, X0, Y0, X1, Y0, { color: '#868e96', width: 1.8 });
text(k, X0 - 14, YTOP - 4, '100%', { size: 14, weight: 700, fill: '#868e96', anchor: 'end' });
text(k, X0 - 14, Y0 + 5, '0%', { size: 14, weight: 700, fill: '#868e96', anchor: 'end' });
text(k, X1, Y0 + 36, '시간', { size: 14, weight: 700, fill: '#868e96', anchor: 'end' });

// burst: 짧은 구간만 100%까지 올라간다
const burst = [[600, 20], [626, 20], [652, 20], [678, 20]];
burst.forEach(([x, w]) => box(k, x, YTOP, w, Y0 - YTOP, { color: C.red, r: 4 }));
// 그 밖의 구간은 낮게 유지
[[180, 380], [184, 380]].forEach(() => {});
for (let x = 180; x < 1080; x += 44) {
  if (x >= 588 && x <= 706) continue;
  box(k, x, 300, 30, Y0 - 300, { color: C.blue, r: 4 });
}

// 평균 70% 선
const yAvg = YTOP + (Y0 - YTOP) * 0.3;
line(k, X0, yAvg, X1, yAvg, { color: C.green.s, width: 1.8, roughness: 0.5 });
text(k, X1 - 10, yAvg - 12, '평균 70%', { size: 15, weight: 700, fill: C.green.s, anchor: 'end' });
text(k, 700, YTOP - 22, '짧은 burst에서 100%', { size: 15, weight: 700, fill: C.red.s });

writeFileSync(process.argv[2], render(k));
