import { canvas, box, frame, text, lines, arrow, route, marker, render, C } from '../draw.mjs';
import { writeFileSync } from 'fs';
// 거짓 성공 두 번
const k = canvas(1400, 430);
marker(k, 700, 46, 520, { color: C.red });
text(k, 700, 46, '완료 감지기가 두 번 거짓으로 통과했다', { size: 27, weight: 700 });
text(k, 700, 76, '에러도 예외도 없이 다음 단계로 넘어갔다', { size: 15, fill: '#868e96' });
const P = [
  { x: 40, h: '첫 번째  명령어 줄을 결과로 읽었다', a: ["cmd -p '... DELEGATE-RESULT 아래에 보고해'", '터미널에 찍힌 자기 명령어'], b: ['표식 매칭 성공', '코더는 아직 아무것도 안 함'] },
  { x: 720, h: '두 번째  지난 실행의 표식을 읽었다', a: ['... DELEGATE-RESULT ...', '스크롤백에 남은 이전 실행 출력'], b: ['표식 매칭 성공', '지금 작업은 시작도 안 함'] },
];
P.forEach((p) => {
  frame(k, p.x, 110, 640, 290, { color: C.red });
  text(k, p.x + 30, 140, p.h, { size: 16, weight: 700, fill: C.red.s, anchor: 'start' });
  box(k, p.x + 40, 162, 560, 80, { color: C.gray });
  lines(k, p.x + 320, 202, p.a, { size: 14, gap: 24 });
  arrow(k, p.x + 320, 248, p.x + 320, 280, { color: C.red.s });
  box(k, p.x + 40, 285, 560, 90, { color: C.red });
  lines(k, p.x + 320, 330, p.b, { size: 16, weight: 700, gap: 26 });
});
writeFileSync(process.argv[2], render(k));
