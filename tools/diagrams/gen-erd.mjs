import { canvas, box, text, arrow, divider, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';

// 포트폴리오 본문이 실제로 다루는 테이블에 order_items 만 더해 그린다. 고르는 기준은 본문 등장 횟수다.
//   정산 19 · 대사 12 · 멱등 8 · 웹훅 5 · 원장 5 · 포인트 5 · 아웃박스 2 · 이상거래 2
// escrow_holds 와 settlement_adjustments 는 본문에 한 번도 안 나와서 뺐다.
//
// <order_items 를 넣은 이유> 본문에는 한 번도 안 나온다. 그래도 넣은 것은 orders 에
// total_amount 만 있고 그 금액이 무엇으로 이뤄졌는지가 그림에 없으면 주문 모델이
// 잘린 것처럼 보이기 때문이다. UK 가 없는 유일한 상자라 그 자리에 근거를 적어 뒀다.
//
// <products 와 stock 을 안 그린 이유> order_items.product_id 가 products 를 가리키지만
// 그 상자는 없다. order_items 가 product_name 과 unit_price 를 주문 시점 값으로 굳혀
// 두기 때문에 주문·정산·환불 어느 경로도 products 를 읽지 않는다. stock 은 문서 9절이
// 밝히듯 락 3종 비교용 실험 테이블이고, 그 실험은 포트폴리오에서 빠졌다.
//
// 컬럼은 한 줄에 하나씩 왼쪽 정렬이고, 이름은 마이그레이션 DDL 에서 그대로 가져왔다.
// 상자 제목 아래 괄호는 그 테이블이 무엇을 담는지 한글로 적은 것이다.
//
// <캔버스 폭을 1200 으로 잡은 이유> A4 본문 폭이 180mm 다. 1400 으로 그리면 글자가
// 3~4pt 로 줄어 PDF 에서 안 읽힌다. 폭을 줄이고 글자를 키워야 실제 크기가 커진다.
// 세로도 함부로 못 늘린다. CSS 가 높이를 250mm 로 막고 있어서 세로/가로 비가 1.25 를
// 넘으면 높이가 먼저 걸리고 가로가 따라 줄어든다. 지금 비는 1492/1200 = 1.243 이다.
const W = 1200;

const ROW = 33, BW = 280;
const X = [30, 320, 610, 900];

// 상자 높이는 컬럼 수로 정해진다. 머리(제목 + 한글 + 구분선) 60, 꼬리(UK 줄) 34.
const H = (n) => 60 + n * ROW + 34;

// 띠의 y 는 앞 띠 바닥에서 간격을 더해 잡는다. 컬럼을 하나 늘려도 아래가 알아서 밀린다.
const BAND = [];
{
  let y = 110;
  for (const [rows, gap] of [[6, 64], [6, 61], [5, 64], [6, 61]]) {
    BAND.push(y);
    y += H(rows) + gap;
  }
  BAND.push(y); // 각주 자리
}
const FOOT = BAND[4];
const k = canvas(W, FOOT + 30);

marker(k, W / 2, 46, 340);
text(k, W / 2, 46, 'pay 핵심 ERD', { size: 27, weight: 700 });
text(k, W / 2, 78, '포트폴리오가 다루는 자리만 골랐다. UK 는 같은 것이 두 번 처리되는 것을 막는 자리다',
     { size: 15, fill: '#868e96' });

const T = (col, band, name, ko, cols, uk, color, tag) => {
  const x = X[col], y = BAND[band], w = BW, h = H(cols.length);
  box(k, x, y, w, h, { color, r: 10 });
  text(k, x + w / 2, y + 28, name, { size: 23, weight: 700 });
  text(k, x + w / 2, y + 50, `(${ko})`, { size: 15, fill: '#868e96' });
  divider(k, x + 12, x + w - 12, y + 58, { color: color.s });
  cols.forEach(([mark, c], i) => {
    const cy = y + 80 + i * ROW;
    if (mark) text(k, x + 16, cy, mark, { size: 15, weight: 700, fill: color.s, anchor: 'start' });
    text(k, x + 52, cy, c, { size: 21, fill: '#495057', anchor: 'start' });
  });
  text(k, x + w / 2, y + h - 12, uk, { size: 16, weight: 700, fill: color.s });
  if (tag) text(k, x + w / 2, y - 10, tag, { size: 16, weight: 700, fill: '#adb5bd' });
  return { x, y, w, h, r: x + w, b: y + h, cx: x + w / 2 };
};

const oi = T(0, 0, 'order_items', '주문 항목',
  [['PK', 'id'], ['FK', 'order_id'], ['', 'product_id'], ['', 'product_name'], ['', 'unit_price'], ['', 'quantity']],
  '주문 시점 스냅샷 · 합이 total_amount', C.gray);
const idem = T(1, 0, 'idempotency_keys', '멱등 키',
  [['PK', 'id'], ['', 'idempotency_key'], ['', 'api_path'], ['', 'http_method'], ['', 'request_hash']],
  'UK 셋을 묶어 = 처리권', C.orange);
const hook = T(2, 0, 'webhook_events', '웹훅 수신',
  [['PK', 'id'], ['', 'external_event_id'], ['', 'event_type'], ['', 'retry_count']],
  'UK external_event_id', C.orange);

const ord = T(0, 1, 'orders', '주문',
  [['PK', 'id'], ['', 'order_no'], ['', 'user_id'], ['', 'status'], ['', 'total_amount'], ['', 'version']],
  'UK order_no', C.blue);
const pay = T(1, 1, 'payments', '결제',
  [['PK', 'id'], ['FK', 'order_no'], ['', 'payment_key'], ['', 'status'], ['', 'balance_amount'], ['', 'unknown_reason']],
  'UNKNOWN 을 지우지 않는다', C.blue);
const out = T(2, 1, 'event_publication', '발행 대기 이벤트',
  [['', 'listener_id'], ['', 'serialized_event'], ['', 'publication_date'], ['', 'completion_date']],
  '비어 있으면 아직 미완료', C.yellow);

arrow(k, oi.cx, oi.b, ord.cx, ord.y, { color: C.gray.s });
text(k, 200, ord.y - 22, 'N:1', { size: 16, fill: '#868e96' });
arrow(k, idem.cx, idem.b, pay.cx, pay.y, { color: C.orange.s });
arrow(k, hook.cx, hook.b, pay.cx + 70, pay.y, { color: C.orange.s });

const MID1 = ord.y + 105;
arrow(k, ord.r, MID1, pay.x, MID1);
text(k, 315, MID1 - 12, '1:N', { size: 16, fill: '#495057' });
arrow(k, pay.r, MID1, out.x, MID1);
text(k, 605, MID1 - 12, '승인', { size: 15, fill: '#495057' });

const pt = T(0, 2, 'point_accounts', '포인트 잔액',
  [['PK', 'user_id'], ['', 'balance'], ['', 'version']],
  'DB 원자 증가 + version', C.blue, '상황 4.1');
const si = T(1, 2, 'settlement_items', '정산 항목',
  [['PK', 'id'], ['FK', 'payment_id'], ['', 'order_no'], ['', 'confirmed_date'], ['', 'seller_id']],
  'UK payment_id', C.purple, '상황 2');
const ltx = T(2, 2, 'ledger_transactions', '원장 거래',
  [['PK', 'id'], ['', 'tx_type'], ['', 'source_type'], ['', 'source_id'], ['', 'source_seq']],
  'UK 넷을 묶어 = 같은 원인 한 번', C.green);
const fr = T(3, 2, 'fraud_reviews', '이상거래 심사',
  [['PK', 'id'], ['', 'payment_id'], ['', 'score · reasons'], ['', 'status'], ['', 'reviewed_by']],
  '승인·거부가 곧 오탐 라벨', C.gray, '상황 5');

arrow(k, pay.cx - 60, pay.b, pt.cx, pt.y);
text(k, 200, pt.y - 42, '적립도 같은 트랜잭션', { size: 15, fill: '#868e96' });
arrow(k, out.cx - 40, out.b, si.cx, si.y, { color: C.yellow.s });
arrow(k, out.cx, out.b, ltx.cx, ltx.y, { color: C.yellow.s });
arrow(k, out.cx + 40, out.b, fr.cx, fr.y, { color: C.yellow.s });

const set = T(1, 3, 'settlements', '일별 정산',
  [['PK', 'id'], ['', 'settlement_date'], ['', 'currency'], ['', 'seller_id (null 가능)'], ['', 'seller_key (생성 컬럼)'], ['', 'net_amount']],
  'UK date+currency+seller_key', C.red, '상황 2');
const led = T(2, 3, 'ledger_entries', '원장 분개',
  [['PK', 'id'], ['FK', 'transaction_id'], ['', 'amount']],
  '차변 합 = 대변 합', C.green);
const rec = T(3, 3, 'reconciliation_results', '대사 결과',
  [['PK', 'id'], ['', 'trade_date'], ['', 'order_no'], ['', 'internal_amount'], ['', 'external_amount'], ['', 'resolve_cause']],
  'UK trade_date + order_no', C.purple, '상황 3.3 · 5');

arrow(k, si.cx, si.b, set.cx, set.y);
text(k, 408, set.y - 20, 'N:1', { size: 16, fill: '#868e96' });
arrow(k, ltx.cx, ltx.b, led.cx, led.y);
text(k, 730, set.y - 20, '1:N', { size: 16, fill: '#868e96' });
arrow(k, fr.cx, fr.b, rec.cx, rec.y, { color: '#ced4da' });

text(k, W / 2, FOOT, '포트폴리오 다섯 절이 다루는 테이블에 주문 구성만 더했다. 전체는 39개이고 회원·상품·재고·월렛·에스크로·감사 로그는 뺐다.',
     { size: 17, fill: '#868e96' });

writeFileSync(process.argv[2] || 'erd.svg', render(k));
