import { canvas, box, frame, text, arrow, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 부탁과 강제 — AI 가 완료까지 판단하는 구조와, 스크립트가 경계를 강제하는 구조.
const k = canvas(1400, 540);

// ── Before: AI 가 구현·테스트·완료 판단을 혼자 한다
text(k, 60, 54, 'Before', { size: 21, weight: 700, fill: C.red.s, anchor: 'start' });
frame(k, 40, 76, 620, 300, { color: C.red });
text(k, 62, 108, 'AI', { size: 17, weight: 700, fill: C.red.s, anchor: 'start' });

[['구현', C.blue], ['테스트', C.blue], ['완료 판단', C.red], ['"끝났습니다"', C.red]].forEach(([t, c], i) => {
  const y = 122 + i * 62;
  box(k, 80, y, 540, 52, { color: c, r: 10 });
  text(k, 350, y + 34, t, { size: 18, weight: 700, fill: c.s });
});

arrow(k, 350, 382, 350, 404, { color: '#adb5bd' });
box(k, 230, 408, 240, 58, { color: C.green, r: 10 });
text(k, 350, 445, '다음 작업', { size: 18, weight: 700, fill: C.green.s });

// ── After: AI 는 구현만, 나머지는 스크립트와 검토 모델이 막는다
text(k, 740, 54, 'After', { size: 21, weight: 700, fill: C.green.s, anchor: 'start' });

box(k, 740, 92, 150, 52, { color: C.gray, r: 10 });
text(k, 815, 125, 'AI', { size: 17, weight: 700, fill: C.gray.s });
arrow(k, 894, 118, 926, 118, { color: '#adb5bd' });
box(k, 930, 92, 150, 52, { color: C.blue, r: 10 });
text(k, 1005, 125, '구현', { size: 17, weight: 700, fill: C.blue.s });

const gates = [
  ['스크립트', '결과 파일이 있는가?', C.blue],
  ['검토 모델', 'diff를 검토했는가?', C.orange],
  ['스크립트', '테스트를 다시 돌렸는가?', C.blue],
];
gates.forEach(([actor, q, c], i) => {
  const y = 188 + i * 84;
  box(k, 770, y, 140, 54, { color: c, r: 10 });
  text(k, 840, y + 35, actor, { size: 15, weight: 700, fill: c.s });
  box(k, 930, y, 420, 54, { color: c, r: 10 });
  text(k, 1140, y + 35, q, { size: 17, weight: 700, fill: c.s });
  if (i < gates.length - 1) arrow(k, 1050, y + 58, 1050, y + 80, { color: '#adb5bd' });
});
arrow(k, 1005, 148, 1005, 184, { color: '#adb5bd' });

// 통과 / 실패 갈림
arrow(k, 1050, 356, 1050, 400, { color: '#adb5bd' });
arrow(k, 1046, 402, 958, 424, { color: '#adb5bd' });
arrow(k, 1054, 402, 1230, 424, { color: '#adb5bd' });
box(k, 836, 428, 244, 58, { color: C.green, r: 10 });
text(k, 958, 465, '통과 → 다음 작업', { size: 16, weight: 700, fill: C.green.s });
box(k, 1108, 428, 244, 58, { color: C.red, r: 10 });
text(k, 1230, 465, '실패 → 되돌림·수정', { size: 16, weight: 700, fill: C.red.s });

writeFileSync(process.argv[2], render(k));
