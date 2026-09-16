import { canvas, box, frame, text, lines, arrow, route, marker, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 지금 방식 한 줄 요약
const k = canvas(1400, 300);
marker(k, 700, 46, 400);
text(k, 700, 46, '지금 방식을 한 줄로 줄이면', { size: 27, weight: 700 });
const S = [
  { c: C.purple, t: '사람', b: '방향과 완료 조건을 정한다' },
  { c: C.blue, t: 'AI', b: '구현한다' },
  { c: C.orange, t: '다른 AI', b: '구현을 의심한다' },
  { c: C.green, t: '사람', b: '마지막 결과를 확인한다' },
];
S.forEach((s, i) => {
  const x = 55 + i * 340;
  box(k, x, 90, 285, 120, { color: s.c });
  text(k, x + 142, 138, s.t, { size: 21, weight: 700 });
  text(k, x + 142, 178, s.b, { size: 15 });
  if (i < 3) arrow(k, x + 290, 150, x + 335, 150);
});
text(k, 700, 262, '코딩은 맡겨도, 끝났다는 판단까지 맡기지는 않는다', { size: 17, weight: 700 });
writeFileSync(process.argv[2], render(k));
