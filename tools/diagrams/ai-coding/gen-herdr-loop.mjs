import { canvas, box, frame, text, lines, arrow, route, marker, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// Herdr 로 하는 일
const k = canvas(1400, 330);
marker(k, 700, 46, 440);
text(k, 700, 46, 'Herdr 로 하는 일은 이 정도다', { size: 27, weight: 700 });
text(k, 700, 76, '완성된 오케스트레이터 대신 터미널을 단위로 두고, 필요한 자동화만 얹었다', { size: 15, fill: '#868e96' });
const S = [
  { c: C.gray, t: ['창 나누기'], s: 'pane split' },
  { c: C.blue, t: ['코더 실행'], s: 'agent start · pane run' },
  { c: C.purple, t: ['작업 전달'], s: 'send-text' },
  { c: C.green, t: ['상태와 결과 확인'], s: '결과 파일 · pane read' },
  { c: C.orange, t: ['같은 세션에', '수정 요청'], s: '창 재사용' },
];
S.forEach((s, i) => {
  const x = 40 + i * 272;
  box(k, x, 115, 235, 115, { color: s.c });
  lines(k, x + 117, s.t.length > 1 ? 160 : 165, s.t, { size: 17, weight: 700, gap: 24 });
  text(k, x + 117, 208, s.s, { size: 13, fill: '#495057' });
  if (i < 4) arrow(k, x + 240, 172, x + 267, 172);
});
route(k, [[1227, 235], [1227, 280], [699, 280], [699, 235]], { color: C.purple.s });
text(k, 963, 304, '고칠 게 남으면 같은 창으로 다시 보낸다', { size: 14, weight: 700, fill: C.purple.s });
writeFileSync(process.argv[2], render(k));
