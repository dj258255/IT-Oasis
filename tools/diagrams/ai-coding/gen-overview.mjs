import { canvas, box, frame, text, lines, arrow, route, marker, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 전체 구조 — 설계, 구현, 검토, 최종 검증
const k = canvas(1400, 400);
marker(k, 700, 46, 470);
text(k, 700, 46, '설계한 쪽이 마지막에 다시 본다', { size: 27, weight: 700 });
text(k, 700, 76, '구현은 싼 모델에 넘기고, 검토는 다른 모델에 맡기고, 최종 확인은 처음 설계한 쪽이 한다', { size: 15, fill: '#868e96' });
const S = [
  { c: C.purple, t: '1  설계', b: ['방향 결정', '완료 조건 정의', '작업 묶음 분해'], f: '메인 세션' },
  { c: C.blue, t: '2  구현', b: ['작업 묶음 하나를', '별도 코더에게 위임'], f: '저렴한 코더' },
  { c: C.orange, t: '3  검토', b: ['구현기와 다른 모델이', 'diff 를 보고 지적만'], f: '다른 계열 모델' },
  { c: C.green, t: '4  최종 검증', b: ['diff 직접 확인', '테스트 재실행', '머지'], f: '다시 메인 세션' },
];
S.forEach((s, i) => {
  const x = 55 + i * 340;
  box(k, x, 115, 285, 175, { color: s.c });
  text(k, x + 142, 150, s.t, { size: 19, weight: 700 });
  lines(k, x + 142, 210, s.b, { size: 15, gap: 24 });
  text(k, x + 142, 272, s.f, { size: 13, fill: '#868e96' });
  if (i < 3) arrow(k, x + 290, 202, x + 335, 202);
});
route(k, [[877, 295], [877, 340], [537, 340], [537, 295]], { color: C.orange.s });
text(k, 707, 364, '지적이 있으면 같은 코더에게 되돌린다', { size: 14, weight: 700, fill: C.orange.s });
writeFileSync(process.argv[2], render(k));
