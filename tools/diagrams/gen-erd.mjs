import { canvas, box, frame, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 700);

marker(k, 700, 46, 400);
text(k, 700, 46, '요건을 스키마에 박았다', { size: 27, weight: 700 });
text(k, 700, 78, '"두 번 처리되면 안 된다"를 코드가 아니라 제약으로 옮겼다. 애플리케이션이 뚫려도 DB가 막는다', { size: 15, fill: '#868e96' });

const T = (x, y, w, title, cols, color, uk) => {
  const h = 54 + cols.length * 22 + (uk ? 30 : 0);
  box(k, x, y, w, h, { color, r: 12 });
  text(k, x + w / 2, y + 32, title, { size: 17, weight: 700 });
  cols.forEach((c, i) => text(k, x + w / 2, y + 56 + i * 22, c, { size: 13, fill: '#495057' }));
  if (uk) text(k, x + w / 2, y + h - 12, uk, { size: 12.5, weight: 700, fill: color.s });
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
};

const orders  = T(60,  140, 250, 'orders',           ['order_no', 'user_id', 'status', 'total_amount'], C.blue,  'UK order_no');
const pays    = T(400, 140, 250, 'payments',         ['order_no', 'payment_key', 'status'], C.blue, 'UK payment_key');
const idem    = T(740, 140, 250, 'idempotency',      ['idempotency_key', 'response'], C.orange, 'UK 멱등키 = 처리권');
const ledger  = T(1080,140, 260, 'ledger_entries',   ['tx_id', 'debit / credit', 'amount'], C.green, '차변 합 = 대변 합');

const items   = T(60,  400, 250, 'settlement_items', ['order_no', 'confirmed_date', 'status'], C.purple, null);
const settle  = T(400, 400, 250, 'settlements',      ['date', 'currency', 'seller_id'], C.purple, 'UK 하루 한 번');
const recon   = T(740, 400, 250, 'recon_results',    ['trade_date', 'order_no', 'result'], C.yellow, 'UK 같은 파일 두 번 OK');
const dispute = T(1080,400, 260, 'disputes',         ['order_no', 'status', 'deadline'], C.red, null);

arrow(k, 315, 200, 395, 200);
arrow(k, 655, 200, 735, 200);
arrow(k, 525, 250, 525, 395, { color: C.purple.s });
arrow(k, 185, 250, 185, 395, { color: C.purple.s });
arrow(k, 655, 460, 735, 460);
arrow(k, 1005, 460, 1075, 460);
arrow(k, 1210, 250, 1210, 395, { color: C.red.s });

box(k, 60, 560, 630, 76, { color: C.gray, r: 14 });
lines(k, 375, 598, ['금액은 원화에 소수점이 없어 정수로 잡았다', '스키마 변경은 전부 마이그레이션으로 남는다'], { size: 15, weight: 600, gap: 25 });
box(k, 710, 560, 630, 76, { color: C.gray, r: 14 });
lines(k, 1025, 598, ['미수금 = 승인 − 취소 − 입금 이 언제 계산해도 맞는다', '대조는 하루 단위로 자르고, 같은 파일을 두 번 올려도 결과가 같다'], { size: 14, weight: 600, gap: 25 });
writeFileSync(process.argv[2], render(k));
