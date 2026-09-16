import { canvas, box, frame, text, lines, arrow, route, marker, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 완료 판정과 성공 판정
const k = canvas(1400, 545);
marker(k, 700, 46, 480);
text(k, 700, 46, '완료 판정과 성공 판정을 따로 둔다', { size: 27, weight: 700 });
text(k, 700, 76, '결과 파일이 생기면 구현이 끝난 것이고, 맞았는지는 그다음 단계에서 본다', { size: 15, fill: '#868e96' });
frame(k, 40, 105, 1320, 170, { color: C.blue });
text(k, 70, 133, '완료 판정  구현이 끝났는가', { size: 16, weight: 700, fill: C.blue.s, anchor: 'start' });
const top = [['요구사항', C.purple], ['설계', C.purple], ['작업 묶음 분해', C.purple], ['코더 선택', C.purple], ['구현', C.blue], ['결과 파일 생성', C.blue]];
top.forEach(([t, c], i) => {
  const x = 70 + i * 212;
  box(k, x, 152, 180, 90, { color: c });
  text(k, x + 90, 203, t, { size: 17, weight: 700 });
  if (i < 5) arrow(k, x + 184, 197, x + 208, 197);
});
route(k, [[1220, 246], [1220, 300], [260, 300], [260, 366]], { color: '#343a40' });
frame(k, 40, 318, 1320, 200, { color: C.green });
text(k, 70, 346, '성공 판정  맞았는가', { size: 16, weight: 700, fill: C.green.s, anchor: 'start' });
const bot = [
  { x: 130, w: 260, t: ['다른 모델의', 'diff 검토'], c: C.orange },
  { x: 470, w: 260, t: ['설계한 쪽의', '최종 diff 확인'], c: C.purple },
  { x: 810, w: 220, t: ['테스트 재실행'], c: C.green },
  { x: 1110, w: 180, t: ['통과'], c: C.green },
];
bot.forEach((b, i) => {
  box(k, b.x, 370, b.w, 90, { color: b.c });
  lines(k, b.x + b.w / 2, b.t.length > 1 ? 413 : 418, b.t, { size: 17, weight: 700, gap: 24 });
  if (i < 3) arrow(k, b.x + b.w + 5, 415, bot[i + 1].x - 5, 415);
});
text(k, 260, 490, '고칠 게 있으면 같은 코더 세션으로 되돌린다', { size: 13, weight: 700, fill: C.orange.s });
writeFileSync(process.argv[2], render(k));
