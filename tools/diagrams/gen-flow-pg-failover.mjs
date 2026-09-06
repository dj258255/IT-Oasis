import { canvas, box, text, lines, arrow, elbow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 520);

marker(k, 700, 46, 380);
text(k, 700, 46, '장애라고 다 넘기면 안 된다', { size: 27, weight: 700 });
text(k, 700, 78, 'PG가 응답했는가, 아니면 요청을 받기라도 했는가', { size: 15, fill: '#868e96' });

box(k, 40, 210, 230, 100, { color: C.gray });
lines(k, 155, 260, ['주 PG에 승인 요청', '가중치 순으로 시도'], { size: 15, weight: 600 });

box(k, 340, 120, 300, 150, { color: C.blue });
text(k, 490, 152, 'PG가 응답했다', { size: 18, weight: 700 });
lines(k, 490, 210, ['승인 → 그대로 확정', '거절 → 다른 PG도 거절', '타임아웃 → 미확정'], { size: 14, gap: 25 });

box(k, 340, 300, 300, 130, { color: C.orange });
text(k, 490, 332, '요청이 닿지 못했다', { size: 18, weight: 700 });
lines(k, 490, 382, ['연결 실패', '서킷 오픈'], { size: 15, gap: 25 });

box(k, 730, 130, 340, 130, { color: C.red });
lines(k, 900, 180, ['넘기지 않는다'], { size: 20, weight: 700, fill: C.red.s });
lines(k, 900, 222, ['이미 처리했을 수 있다.', '넘기면 카드가 두 번 긁힌다'], { size: 14, gap: 23 });

box(k, 730, 310, 340, 110, { color: C.green });
lines(k, 900, 348, ['다음 PG로 넘긴다'], { size: 20, weight: 700, fill: C.green.s });
lines(k, 900, 388, ['요청이 나갔다고 볼 근거가 없다'], { size: 14 });

elbow(k, 275, 260, 335, 195, { color: C.blue.s });
elbow(k, 275, 260, 335, 365, { color: C.orange.s });
arrow(k, 645, 195, 725, 195, { color: C.red.s });
arrow(k, 645, 365, 725, 365, { color: C.green.s });

box(k, 1110, 210, 250, 100, { color: C.yellow });
lines(k, 1235, 260, ['넘김은 전용 신호로만', '판정한다 · 테스트 7종'], { size: 14.5, weight: 700, gap: 24 });
writeFileSync(process.argv[2], render(k));
