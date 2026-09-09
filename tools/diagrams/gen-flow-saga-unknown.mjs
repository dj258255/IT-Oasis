import { canvas, box, frame, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 640);

marker(k, 700, 46, 460);
text(k, 700, 46, '타임아웃은 성공도 실패도 아니다', { size: 27, weight: 700 });
text(k, 700, 78, '답이 없다고 실패로 단정하지 않는다. PG 호출은 트랜잭션 밖에서 한다', { size: 15, fill: '#868e96' });

const steps = [
  { t: '① 자리 잡기 (DB)', d: ['주문을 결제 중으로', '내가 처리한다고 표시', '멱등키를 먼저 넣는다'], c: C.blue },
  { t: '② PG 승인 (DB 밖)', d: ['DB 연결을 놓고 부른다', '장애가 이어지면 안 부른다', '승인 · 거절 · 타임아웃'], c: C.orange },
  { t: '③ 확정 또는 되돌리기', d: ['승인 성공 뒤 재고를 깎는다', '재고 부족: 승인을 되돌림', '장부·정산은 소식을 받는다'], c: C.green },
];
steps.forEach((s, i) => {
  const x = 40 + i * 450;
  box(k, x, 120, 420, 160, { color: s.c });
  text(k, x + 210, 158, s.t, { size: 18, weight: 700 });
  lines(k, x + 210, 218, s.d, { size: 14.5, gap: 26 });
  if (i < 2) arrow(k, x + 425, 200, x + 445, 200);
});

box(k, 250, 330, 900, 118, { color: C.red });
lines(k, 700, 372, ['타임아웃. 성공인지 실패인지 모른다'], { size: 20, weight: 700, fill: C.red.s });
lines(k, 700, 415, ['"모른다"로 남긴다 · 추측으로 처리하지 않는다 · 상태로 남기는 것이 핵심'], { size: 15, weight: 600 });

box(k, 250, 478, 900, 76, { color: C.purple });
lines(k, 700, 516, ['복구가 다시 물어 확정한다', '승인됐으면 완결 · 없다고 명시하면 실패 확정 · 이미 취소면 취소 · 진행 중이면 미확정 유지'], { size: 15, weight: 600, gap: 25 });
arrow(k, 700, 452, 700, 474, { color: C.purple.s });

text(k, 700, 596, '실측(시나리오 1건): DB에 5초 지연을 주입해 절반만 저장되는 일 없이 실패했고, 지연을 걷은 뒤 같은 멱등키로 다시 부르니 같은 주문번호로 성공했다', { size: 15, fill: '#868e96' });
writeFileSync(process.argv[2], render(k));
