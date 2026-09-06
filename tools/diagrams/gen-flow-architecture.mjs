import { canvas, box, frame, text, lines, arrow, elbow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';

// 모듈 경계 — 결제 코어가 다른 모듈을 직접 부르지 못하고, 소식만 지나간다
const k = canvas(1400, 620);

marker(k, 700, 46, 480);
text(k, 700, 46, '모듈은 서로를 직접 부르지 않는다', { size: 27, weight: 700 });
text(k, 700, 76, '내부 구현으로 가는 직접 호출은 빌드가 막고, 지나가는 것은 소식뿐이다', { size: 15, fill: '#868e96' });

frame(k, 40, 110, 1320, 210, { color: C.gray });
text(k, 70, 138, '막힌다 — ModularityTests 가 CI 에서 깬다', { size: 15, weight: 700, fill: C.red.s, anchor: 'start' });

box(k, 90, 168, 250, 110, { color: C.blue });
lines(k, 215, 223, ['결제 코어', 'payment'], { size: 18, weight: 700 });

box(k, 560, 168, 280, 110, { color: C.green });
lines(k, 700, 223, ['정산', 'settlement.internal'], { size: 18, weight: 700 });

box(k, 1060, 168, 250, 110, { color: C.orange });
lines(k, 1185, 223, ['원장', 'ledger.internal'], { size: 18, weight: 700 });

arrow(k, 345, 223, 553, 223, { color: C.red.s });
text(k, 449, 208, '직접 호출  ✕', { size: 15, weight: 700, fill: C.red.s });
arrow(k, 845, 223, 1053, 223, { color: C.red.s });
text(k, 949, 208, '직접 호출  ✕', { size: 15, weight: 700, fill: C.red.s });

frame(k, 40, 350, 1320, 240, { color: C.purple });
text(k, 70, 378, '지나간다 — 이벤트만', { size: 15, weight: 700, fill: C.green.s, anchor: 'start' });

box(k, 90, 408, 250, 110, { color: C.blue });
lines(k, 215, 463, ['결제 코어', '승인이 끝났다'], { size: 18, weight: 700 });

box(k, 520, 400, 360, 126, { color: C.yellow });
lines(k, 700, 463, ['이벤트 저장소', '커밋과 같은 트랜잭션에 남는다', '못 보내면 다시 보낸다'], { size: 15, weight: 600, gap: 24 });

box(k, 1060, 396, 250, 62, { color: C.green });
text(k, 1185, 433, '정산', { size: 18, weight: 700 });
box(k, 1060, 476, 250, 62, { color: C.orange });
text(k, 1185, 513, '원장', { size: 18, weight: 700 });

arrow(k, 345, 463, 513, 463);
elbow(k, 885, 463, 1053, 427);
elbow(k, 885, 463, 1053, 507);

text(k, 700, 566, '보낸 쪽은 받는 쪽을 모른다. 받는 쪽이 늘어도 결제 코어는 안 바뀐다.', { size: 15, fill: '#868e96' });

writeFileSync(process.argv[2], render(k));
console.log('  →', process.argv[2]);
