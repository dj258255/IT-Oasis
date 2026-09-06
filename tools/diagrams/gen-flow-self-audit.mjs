import { canvas, box, frame, text, lines, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 400);

marker(k, 700, 46, 470);
text(k, 700, 46, '새 결제수단이 같은 약속을 지키는가', { size: 27, weight: 700 });
text(k, 700, 78, '네 자리를 나란히 놓으니 한 칸이 비어 있었다. 테스트로는 안 채워진다', { size: 15, fill: '#868e96' });

const cols = ['예약', '보상', '취소', '중복 방지'];
const w = 300, gap = 24, x0 = 40;
cols.forEach((c, i) => {
  const x = x0 + i * (w + gap);
  const bad = i === 2;
  box(k, x, 120, w, 130, { color: bad ? C.red : C.green });
  text(k, x + w / 2, 165, c, { size: 21, weight: 700 });
  if (bad) lines(k, x + w / 2, 205, ['월렛을 몰랐다', '환불이 그대로 증발'], { size: 15, weight: 700, fill: C.red.s });
  else text(k, x + w / 2, 205, '기존 수단과 같음', { size: 15, fill: '#495057' });
});

box(k, 40, 282, 1320, 62, { color: C.red, r: 14 });
text(k, 700, 320, '실제 재현 — 월렛 6,000원이 사라졌다. 유닛테스트는 전부 초록불이었다', { size: 18, weight: 700 });
writeFileSync(process.argv[2], render(k));
