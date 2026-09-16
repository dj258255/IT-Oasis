import { canvas, box, frame, text, lines, arrow, route, marker, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 캐시를 지키는 라우팅
const k = canvas(1400, 420);
marker(k, 700, 46, 330);
text(k, 700, 46, '라우팅 기준은 캐시다', { size: 27, weight: 700 });
text(k, 700, 76, '작업 묶음 하나가 끝날 때까지 코더와 세션을 바꾸지 않는다', { size: 15, fill: '#868e96' });
frame(k, 40, 110, 860, 200, { color: C.green });
text(k, 70, 140, '묶음 B1  같은 코더, 같은 세션', { size: 16, weight: 700, fill: C.green.s, anchor: 'start' });
['1차 구현', '2차 수정', '3차 수정'].forEach((t, i) => {
  const x = 80 + i * 270;
  box(k, x, 170, 230, 90, { color: C.blue });
  text(k, x + 115, 221, t, { size: 18, weight: 700 });
  if (i < 2) arrow(k, x + 235, 215, x + 265, 215);
});
text(k, 470, 290, '이미 읽은 코드를 다시 읽지 않는다', { size: 14, fill: '#495057' });
arrow(k, 905, 215, 980, 215);
text(k, 942, 198, '경계', { size: 14, weight: 700 });
frame(k, 985, 110, 375, 200, { color: C.gray });
text(k, 1015, 140, '묶음 B2', { size: 16, weight: 700, fill: '#495057', anchor: 'start' });
box(k, 1020, 170, 305, 90, { color: C.purple });
lines(k, 1172, 215, ['필요하면 여기서', '다른 코더로 바꾼다'], { size: 16, weight: 700, gap: 24 });
box(k, 40, 335, 1320, 62, { color: C.red, r: 14 });
text(k, 700, 373, '묶음 도중 코더를 바꾸면 새 코더가 관련 코드를 처음부터 다시 읽는다', { size: 17, weight: 700 });
writeFileSync(process.argv[2], render(k));
