import { canvas, box, frame, text, lines, arrow, elbow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';

// 이커머스 플랫폼 전체 — 손님이 들어와 돈이 확정되고 판매자에게 지급되기까지.
// 모듈 26개를 역할로 묶고, 그 사이를 무엇이 지나가는지를 그린다.
const k = canvas(1560, 1180);

marker(k, 780, 46, 620);
text(k, 780, 46, 'BE-commerce — 손님이 들어와 판매자에게 돈이 가기까지', { size: 27, weight: 700 });
text(k, 780, 76, '모듈 26개. 가로선 위는 요청이 지나가는 길, 아래는 이벤트가 지나가는 길이다',
  { size: 15, fill: '#868e96' });

// ── 1. 유입 ────────────────────────────────────────────────────────────
frame(k, 40, 110, 320, 230, { color: C.gray });
text(k, 60, 138, '1. 유입 — 누구까지 들여보내나', { size: 15, weight: 700, fill: C.gray.s, anchor: 'start' });
box(k, 70, 160, 260, 50, { color: C.gray });
text(k, 200, 190, 'auth · member', { size: 16, weight: 700 });
box(k, 70, 220, 260, 50, { color: C.red });
lines(k, 200, 238, ['ratelimit · queue'], { size: 16, weight: 700 });
text(k, 200, 262, '초과 97.5% 차단', { size: 13, fill: C.red.s });
text(k, 200, 300, '모두가 느려지는 대신', { size: 13, fill: '#868e96' });
text(k, 200, 318, '일부를 거절한다', { size: 13, fill: '#868e96' });

// ── 2. 탐색 ────────────────────────────────────────────────────────────
frame(k, 400, 110, 380, 230, { color: C.blue });
text(k, 420, 138, '2. 탐색 — 무엇을 보여주나', { size: 15, weight: 700, fill: C.blue.s, anchor: 'start' });
box(k, 430, 160, 320, 50, { color: C.blue });
text(k, 590, 190, 'catalog (상품 · 카테고리 · 패싯)', { size: 15, weight: 700 });
box(k, 430, 220, 150, 50, { color: C.blue });
text(k, 505, 250, 'wishlist', { size: 15, weight: 700 });
box(k, 600, 220, 150, 50, { color: C.blue });
text(k, 675, 250, 'seller', { size: 15, weight: 700 });
text(k, 590, 300, '검색 엔진은 안 넣었다 — 300ms 초과의', { size: 13, fill: '#868e96' });
text(k, 590, 318, '원인이 집계가 아니라 포화였다 (ADR-044)', { size: 13, fill: '#868e96' });

// ── 3. 개인화 ──────────────────────────────────────────────────────────
frame(k, 820, 110, 700, 230, { color: C.purple });
text(k, 840, 138, '3. 개인화 — 모델이 죽어도 상점은 열린다', { size: 15, weight: 700, fill: C.purple.s, anchor: 'start' });
box(k, 850, 160, 200, 50, { color: C.purple });
text(k, 950, 190, 'home (조립)', { size: 15, weight: 700 });
box(k, 1070, 160, 200, 50, { color: C.purple });
text(k, 1170, 190, 'recommendation', { size: 15, weight: 700 });
box(k, 1290, 160, 210, 50, { color: C.yellow });
text(k, 1395, 190, 'ModelClient (스텁)', { size: 14, weight: 700 });
box(k, 850, 220, 420, 50, { color: C.purple });
text(k, 1060, 250, 'personalization (컨텍스트 · 신선도)', { size: 15, weight: 700 });
box(k, 1290, 220, 210, 50, { color: C.green });
text(k, 1395, 250, '과부하 게이트', { size: 15, weight: 700 });
text(k, 1170, 300, '모델을 학습해 붙여 보고 안 넣었다 — 기준선의 1/3 (ADR-048).', { size: 13, fill: '#868e96' });
text(k, 1170, 318, '느리면 coverage 를 포기하고 상점은 계속 연다 (ADR-037)', { size: 13, fill: '#868e96' });

arrow(k, 365, 225, 425, 225);
arrow(k, 785, 225, 845, 225);

// ── 4. 주문·결제 ───────────────────────────────────────────────────────
frame(k, 40, 380, 740, 300, { color: C.green });
text(k, 60, 408, '4. 주문 · 결제 — 3단계 사가', { size: 15, weight: 700, fill: C.green.s, anchor: 'start' });
box(k, 70, 432, 200, 56, { color: C.green });
lines(k, 170, 452, ['① 예약', 'order'], { size: 14, weight: 700, gap: 20 });
box(k, 290, 432, 200, 56, { color: C.green });
lines(k, 390, 452, ['② PG 승인', 'payment'], { size: 14, weight: 700, gap: 20 });
box(k, 510, 432, 200, 56, { color: C.green });
lines(k, 610, 452, ['③ 확정 / 보상', 'order'], { size: 14, weight: 700, gap: 20 });
arrow(k, 275, 460, 285, 460);
arrow(k, 495, 460, 505, 460);

box(k, 70, 510, 200, 50, { color: C.orange });
text(k, 170, 540, 'point · wallet', { size: 15, weight: 700 });
box(k, 290, 510, 200, 50, { color: C.orange });
text(k, 390, 540, 'subscription', { size: 15, weight: 700 });
box(k, 510, 510, 200, 50, { color: C.orange });
text(k, 610, 540, 'receipt', { size: 15, weight: 700 });

box(k, 70, 578, 640, 54, { color: C.red });
lines(k, 390, 596, ['PG 동시 호출 상한 40 — 느린 PG 가 조회까지 끌어내리는 것을 막는다'], { size: 14, weight: 700 });
text(k, 390, 620, '거절률 = 1 − 상한 ÷ (도착률 × 지연). 실측 오차 0.0%p (ADR-022)', { size: 13, fill: C.red.s });
text(k, 390, 658, '타임아웃은 실패가 아니라 UNKNOWN 이다. 복구가 PG 에 다시 묻는다', { size: 13, fill: '#868e96' });

// 외부 PG
box(k, 830, 432, 220, 56, { color: C.gray, fill: false });
lines(k, 940, 452, ['외부 PG', '토스 · 카카오페이'], { size: 14, weight: 700, gap: 20 });
arrow(k, 495, 445, 825, 445);
arrow(k, 825, 475, 495, 475);
text(k, 660, 432, '승인 요청', { size: 12, fill: '#868e96' });
text(k, 660, 496, '웹훅 · 조회', { size: 12, fill: '#868e96' });

// ── 5. 이벤트 경계 ─────────────────────────────────────────────────────
box(k, 1100, 420, 420, 90, { color: C.yellow });
lines(k, 1310, 448, ['이벤트 저장소 (Outbox)', '커밋과 같은 트랜잭션에 남는다'], { size: 15, weight: 700, gap: 24 });
text(k, 1310, 496, '재기동 8초 내 재발행 확인', { size: 13, fill: C.yellow.s });
arrow(k, 715, 605, 1095, 500);
text(k, 900, 545, '승인이 끝났다', { size: 13, fill: '#868e96' });

// ── 6. 자금 정합성 ─────────────────────────────────────────────────────
frame(k, 40, 720, 740, 260, { color: C.orange });
text(k, 60, 748, '6. 자금 정합성 — 돈이 맞는지 따로 센다', { size: 15, weight: 700, fill: C.orange.s, anchor: 'start' });
box(k, 70, 772, 200, 56, { color: C.orange });
lines(k, 170, 792, ['ledger', '차변 = 대변'], { size: 14, weight: 700, gap: 20 });
box(k, 290, 772, 200, 56, { color: C.orange });
lines(k, 390, 792, ['escrow', '7일 홀드'], { size: 14, weight: 700, gap: 20 });
box(k, 510, 772, 200, 56, { color: C.orange });
lines(k, 610, 792, ['settlement', '구매확정일 기준'], { size: 14, weight: 700, gap: 20 });
box(k, 70, 848, 640, 56, { color: C.orange });
lines(k, 390, 868, ['reconciliation — 외부 기록과 대조해 지급을 연다'], { size: 15, weight: 700 });
text(k, 390, 892, 'MATCHED 일 때만 PAID_OUT. 대사가 최종 방어선이다', { size: 13, fill: C.orange.s });
text(k, 390, 932, '정산일은 번 날이 아니라 쓸어 담은 날이다 — 집계일 의미는 안 바꾸고 조회로 드러낸다 (ADR-023)', { size: 13, fill: '#868e96' });
text(k, 390, 956, '원장 잔액은 SUM + 커버링 인덱스. 스냅샷은 60만~130만 행에서 필요해진다 (ADR-025)', { size: 13, fill: '#868e96' });

// ── 7. 운영 안전장치 ───────────────────────────────────────────────────
frame(k, 820, 720, 700, 260, { color: C.blue });
text(k, 840, 748, '7. 운영 — 규칙이 못 가른 것만 사람에게', { size: 15, weight: 700, fill: C.blue.s, anchor: 'start' });
box(k, 850, 772, 200, 56, { color: C.blue });
lines(k, 950, 792, ['fraud', '심사 큐'], { size: 14, weight: 700, gap: 20 });
box(k, 1070, 772, 200, 56, { color: C.blue });
lines(k, 1170, 792, ['dispute', '차지백'], { size: 14, weight: 700, gap: 20 });
box(k, 1290, 772, 210, 56, { color: C.blue });
lines(k, 1395, 792, ['notification', '멱등 소비 · DLT'], { size: 14, weight: 700, gap: 20 });
box(k, 850, 848, 320, 56, { color: C.blue });
lines(k, 1010, 868, ['timeline — 10개 도메인을 주문 하나로'], { size: 14, weight: 700 });
box(k, 1190, 848, 310, 56, { color: C.yellow });
lines(k, 1345, 868, ['assist (LLM) — 초안까지만'], { size: 14, weight: 700 });
text(k, 1170, 932, 'DLT 격리는 유실이 아니다. 대사가 받아 주므로 검출 가능한 미처리가 된다 (ADR-030)', { size: 13, fill: '#868e96' });
text(k, 1170, 956, '모델이 낸 것을 업무에 반영할지는 사람이 정한다. audit 이 그 판단을 남긴다', { size: 13, fill: '#868e96' });

elbow(k, 1310, 515, 400, 765);
elbow(k, 1310, 515, 1100, 765);

// ── 아래 띠 ────────────────────────────────────────────────────────────
box(k, 40, 1010, 1480, 60, { color: C.purple });
lines(k, 780, 1030, ['모듈은 서로의 내부를 직접 부르지 않는다 — 공개 API 와 도메인 이벤트로만 잇는다'], { size: 16, weight: 700 });
text(k, 780, 1054, 'internal 로 가는 직접 호출은 ModularityTests 가 CI 에서 깬다 (ADR-018)', { size: 13, fill: C.purple.s });

text(k, 780, 1110, 'shared 는 값 타입만 담는다. 26개 모듈 중 어느 것도 다른 모듈의 internal 을 import 하지 않는다.', { size: 14, fill: '#868e96' });
text(k, 780, 1136, '수치는 로컬 단일 장비 실측이고, 조건과 한계는 docs/performance 에 같이 적었다.', { size: 13, fill: '#adb5bd' });

writeFileSync(process.argv[2], render(k));
