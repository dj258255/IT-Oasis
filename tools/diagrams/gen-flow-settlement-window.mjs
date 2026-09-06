import { canvas, box, frame, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 560);

marker(k, 700, 46, 470);
text(k, 700, 46, '날짜 하나가 지급을 통째로 빠뜨렸다', { size: 27, weight: 700 });
text(k, 700, 78, '주문 하나의 시간선으로 보면', { size: 15, fill: '#868e96' });

box(k, 220, 118, 240, 66, { color: C.blue });
text(k, 340, 157, '승인 (D0)', { size: 18, weight: 700 });
box(k, 940, 118, 240, 66, { color: C.green });
text(k, 1060, 157, '구매확정 (D+5)', { size: 18, weight: 700 });
arrow(k, 465, 151, 935, 151);
text(k, 700, 138, '배송과 확정 대기 5일', { size: 14, fill: '#868e96' });

frame(k, 40, 218, 640, 200, { color: C.red });
text(k, 360, 250, '개선 전 — 집계 키가 승인일(D0)', { size: 18, weight: 700, fill: C.red.s });
lines(k, 360, 305, ['확정 시점(D+5)에 D0 날짜로 집계', 'D0 자 정산은 이미 마감'], { size: 15, gap: 27 });
box(k, 90, 340, 500, 56, { color: C.red });
text(k, 340, 375, '지급 누락 — 에러 0건, 테스트도 초록불', { size: 17, weight: 700 });

frame(k, 720, 218, 640, 200, { color: C.green });
text(k, 1040, 250, '개선 후 — 집계 키가 구매확정일(D+5)', { size: 18, weight: 700, fill: C.green.s });
lines(k, 1040, 305, ['구매확정 시각으로 집계', 'D+5 자 정산에 포함'], { size: 15, gap: 27 });
box(k, 770, 340, 500, 56, { color: C.green });
text(k, 1020, 375, '2영업일 뒤 지급확정', { size: 17, weight: 700 });
arrow(k, 686, 318, 714, 318, { color: C.purple.s });

box(k, 40, 448, 1320, 62, { color: C.yellow, r: 14 });
text(k, 700, 478, '테스트가 승인일과 확정일이 같은 조건에서만 돌아 버그를 가렸다 — 간격이 있는 테스트를 추가해 재발 차단', { size: 16, weight: 700 });
text(k, 700, 500, '수수료 검산: 매출 100,000원 중 지급 97,030원을 테스트로 고정', { size: 13.5, fill: '#495057' });
writeFileSync(process.argv[2], render(k));
