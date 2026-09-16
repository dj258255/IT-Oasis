import { canvas, box, frame, text, lines, arrow, route, marker, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 한 번에 끝나지 않는 흐름
const k = canvas(1400, 330);
marker(k, 700, 46, 460);
text(k, 700, 46, '한 번에 끝나는 요청은 거의 없다', { size: 27, weight: 700 });
text(k, 700, 76, '그래서 코더를 한 번 쓰고 버리지 않고, 묶음이 끝날 때까지 같은 세션으로 둔다', { size: 15, fill: '#868e96' });
const S = [['구현', C.blue], ['테스트', C.gray], ['오류 발견', C.red], ['수정 요청', C.orange]];
S.forEach(([t, c], i) => {
  const x = 60 + i * 270;
  box(k, x, 130, 230, 90, { color: c });
  text(k, x + 115, 181, t, { size: 18, weight: 700 });
  if (i < 3) arrow(k, x + 235, 175, x + 265, 175);
});
arrow(k, 1095, 175, 1135, 175);
box(k, 1140, 130, 220, 90, { color: C.green });
lines(k, 1250, 175, ['diff 검토', '추가 수정'], { size: 17, weight: 700, gap: 24 });
route(k, [[985, 225], [985, 268], [445, 268], [445, 225]], { color: C.blue.s });
text(k, 715, 292, '고치면 다시 테스트. 이 고리가 같은 세션 안에서 돈다', { size: 14, weight: 700, fill: C.blue.s });
writeFileSync(process.argv[2], render(k));
