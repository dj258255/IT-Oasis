import { canvas, box, frame, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 620);

marker(k, 700, 46, 400);
text(k, 700, 46, '읽지 않으면 충돌하지 않는다', { size: 27, weight: 700 });
text(k, 700, 78, '낙관적 락을 걸어 뒀는데도 무너졌다. 문 앞 rate limit 이 이 결함을 가리고 있었다', { size: 15, fill: '#868e96' });

frame(k, 40, 112, 640, 250, { color: C.red });
text(k, 360, 142, '개선 전 — 읽고 고치고 쓰기 (+ @Version)', { size: 18, weight: 700, fill: C.red.s });
box(k, 70, 168, 240, 74, { color: C.gray }); lines(k, 190, 205, ['결제 A의 적립', '잔액 읽기: 1,000'], { size: 15 });
box(k, 70, 258, 240, 74, { color: C.gray }); lines(k, 190, 295, ['결제 B의 적립', '잔액 읽기: 1,000'], { size: 15 });
box(k, 400, 200, 250, 100, { color: C.red });
lines(k, 525, 250, ['같은 계좌 행에 동시 쓰기', '낙관적 락 충돌'], { size: 16, weight: 700 });
arrow(k, 315, 205, 395, 232, { color: C.red.s });
arrow(k, 315, 295, 395, 268, { color: C.red.s });
text(k, 360, 350, '승인까지 500으로 번졌다 — 성공률 39.6%', { size: 16, weight: 700, fill: C.red.s });

frame(k, 720, 112, 640, 250, { color: C.green });
text(k, 1040, 142, '개선 후 — DB 원자 증가', { size: 18, weight: 700, fill: C.green.s });
box(k, 750, 168, 240, 74, { color: C.gray }); lines(k, 870, 205, ['결제 A의 적립', '읽지 않음'], { size: 15 });
box(k, 750, 258, 240, 74, { color: C.gray }); lines(k, 870, 295, ['결제 B의 적립', '읽지 않음'], { size: 15 });
box(k, 1060, 190, 270, 120, { color: C.green });
lines(k, 1195, 250, ['UPDATE balance = balance + n,', 'version = version + 1', '순서 무관 · 앱 재시도 없음'], { size: 14, weight: 600, gap: 24 });
arrow(k, 995, 205, 1055, 228, { color: C.green.s });
arrow(k, 995, 295, 1055, 272, { color: C.green.s });
text(k, 1040, 350, '같은 부하 재실험 — 성공률 100% (6,761/6,761)', { size: 16, weight: 700, fill: C.green.s });

box(k, 40, 396, 1320, 60, { color: C.yellow, r: 14 });
text(k, 700, 432, 'version 도 함께 올려 낡은 잔액 덮어쓰기를 막았다 — 사용·환불이 낙관적 락 감시를 벗어나지 않게', { size: 16, weight: 700 });
box(k, 40, 476, 1320, 60, { color: C.blue, r: 14 });
text(k, 700, 512, '검증: 잔액과 포인트 원장을 별도 경로로 대조, 불일치 0 (978,400 = 978,400)', { size: 16, weight: 700 });
text(k, 700, 578, '이 결함을 보려면 rate limit 을 꺼야 했다. 유입 제어가 동시성을 눌러 안 보이게 하고 있었다.', { size: 15, fill: '#868e96' });

writeFileSync(process.argv[2], render(k));
