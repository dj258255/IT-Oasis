import { canvas, box, frame, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 620);

marker(k, 700, 46, 400);
text(k, 700, 46, '적립의 락 충돌을 없애고, 오래된 값으로 덮어쓰는 갱신은 version 으로 잡는다', { size: 27, weight: 700 });
text(k, 700, 78, '동시 적립의 낙관적 락 충돌이 결제 API 오류로 번졌다', { size: 15, fill: '#868e96' });

frame(k, 40, 112, 640, 250, { color: C.red });
text(k, 360, 142, '개선 전: 읽고 고치고 쓰기 (+ @Version)', { size: 18, weight: 700, fill: C.red.s });
box(k, 70, 168, 240, 74, { color: C.gray }); lines(k, 190, 205, ['결제 A의 적립', '잔액 읽기: 1,000'], { size: 15 });
box(k, 70, 258, 240, 74, { color: C.gray }); lines(k, 190, 295, ['결제 B의 적립', '잔액 읽기: 1,000'], { size: 15 });
box(k, 400, 200, 250, 100, { color: C.red });
lines(k, 525, 250, ['같은 계좌 행에 동시 쓰기', '낙관적 락 충돌'], { size: 16, weight: 700 });
arrow(k, 315, 205, 395, 232, { color: C.red.s });
arrow(k, 315, 295, 395, 268, { color: C.red.s });
text(k, 360, 350, '결제 승인 API가 500을 반환했다. 2xx 응답 비율 39.6%', { size: 16, weight: 700, fill: C.red.s });

frame(k, 720, 112, 640, 250, { color: C.green });
text(k, 1040, 142, '개선 후: DB 원자 증가', { size: 18, weight: 700, fill: C.green.s });
box(k, 750, 168, 240, 74, { color: C.gray }); lines(k, 870, 205, ['결제 A의 적립', '잔액 사전 조회 없음'], { size: 15 });
box(k, 750, 258, 240, 74, { color: C.gray }); lines(k, 870, 295, ['결제 B의 적립', '잔액 사전 조회 없음'], { size: 15 });
box(k, 1060, 190, 270, 120, { color: C.green });
lines(k, 1195, 250, ['UPDATE balance = balance + n,', 'version = version + 1', '순서 무관 · 앱 재시도 없음'], { size: 14, weight: 600, gap: 24 });
arrow(k, 995, 205, 1055, 228, { color: C.green.s });
arrow(k, 995, 295, 1055, 272, { color: C.green.s });
text(k, 1040, 350, '같은 부하 재실험. 2xx 응답 비율 100% (6,761/6,761)', { size: 16, weight: 700, fill: C.green.s });

box(k, 40, 396, 1320, 60, { color: C.yellow, r: 14 });
text(k, 700, 432, 'version 도 함께 올려 낡은 잔액 덮어쓰기를 막았다. 사용·환불이 낙관적 락 감시를 벗어나지 않게', { size: 16, weight: 700 });
box(k, 40, 476, 1320, 60, { color: C.blue, r: 14 });
text(k, 700, 512, '검증: 포인트 잔액 978,400 = 원장 대조 금액 978,400, 불일치 0', { size: 16, weight: 700 });

writeFileSync(process.argv[2], render(k));
