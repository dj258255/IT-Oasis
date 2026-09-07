import { canvas, box, frame, text, lines, arrow, elbow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 604);

marker(k, 700, 46, 380);
text(k, 700, 46, '400이라고 다 실패가 아니다', { size: 27, weight: 700 });
text(k, 700, 78, '같은 400 안에 성격이 완전히 다른 셋이 섞여 있었다', { size: 15, fill: '#868e96' });

box(k, 40, 230, 220, 100, { color: C.gray });
lines(k, 150, 280, ['PG 에러 응답', '{ code, message }'], { size: 16, weight: 600 });

const kinds = [
  { codes: ['REJECT_CARD_COMPANY 403', 'INVALID_STOPPED_CARD 400'], verdict: '실패로 확정', note: '카드사가 거절했다', c: C.red },
  { codes: ['PROVIDER_ERROR 400', '문서에 없는 코드'], verdict: '미확정으로 보존', note: '복구 배치가 나중에 확정', c: C.orange },
  { codes: ['ALREADY_PROCESSED_PAYMENT 400'], verdict: '조회로 확정', note: '추측하지 않고 다시 묻는다', c: C.green },
];
kinds.forEach((kd, i) => {
  const y = 130 + i * 130;
  box(k, 330, y, 420, 100, { color: kd.c });
  lines(k, 540, y + 50, kd.codes, { size: 14.5, weight: 600, gap: 26 });
  box(k, 830, y, 320, 100, { color: kd.c });
  lines(k, 990, y + 50, [kd.verdict, kd.note], { size: 15, weight: 700, gap: 26 });
  elbow(k, 265, 280, 325, y + 50, { color: kd.c.s });
  arrow(k, 755, y + 50, 825, y + 50, { color: kd.c.s });
});

box(k, 40, 514, 1320, 56, { color: C.yellow, r: 14 });
text(k, 700, 548, '이걸 안 가르면 이미 승인된 결제를 실패로 기록한다. 고객 돈은 나가고 우리 장부만 실패다', { size: 17, weight: 700 });
writeFileSync(process.argv[2], render(k));
