import { canvas, box, frame, text, lines, arrow, route, marker, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 비용으로 나눈 역할
const k = canvas(1400, 380);
marker(k, 700, 46, 360);
text(k, 700, 46, '역할을 비용으로 나눴다', { size: 27, weight: 700 });
text(k, 700, 76, '판단은 비싼 모델에, 반복은 싼 모델에', { size: 15, fill: '#868e96' });
frame(k, 70, 110, 580, 220, { color: C.purple });
text(k, 360, 145, '비싼 모델', { size: 20, weight: 700, fill: C.purple.s });
box(k, 120, 170, 480, 130, { color: C.purple });
lines(k, 360, 235, ['설계', '어려운 판단', '최종 검토'], { size: 18, weight: 700, gap: 34 });
frame(k, 750, 110, 580, 220, { color: C.blue });
text(k, 1040, 145, '저렴한 모델', { size: 20, weight: 700, fill: C.blue.s });
box(k, 800, 170, 480, 130, { color: C.blue });
lines(k, 1040, 235, ['실제 코드 작성', '반복 구현'], { size: 18, weight: 700, gap: 34 });
arrow(k, 655, 235, 745, 235);
text(k, 700, 222, '위임', { size: 15, weight: 700 });
text(k, 700, 360, '코드베이스를 읽고 고치기를 되풀이하는 쪽을 싼 모델로 보냈다', { size: 15, fill: '#495057' });
writeFileSync(process.argv[2], render(k));
