import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 640);

marker(k, 700, 46, 520);
text(k, 700, 46, '느린 PG 앞에서 워커 100개를 셋이 나눠 쓴다', { size: 27, weight: 700 });
text(k, 700, 80, 'PG 지연 5초 · 결제 도착률 50/s · 가짜 PG · 로컬 실측', { size: 15, fill: '#868e96' });
text(k, 700, 104, '조회 수치는 결제+조회 부하, 웹훅 수치는 결제+웹훅(10/s) 부하에서 따로 쟀다', { size: 13, fill: '#868e96' });

// 들어오는 요청 셋
box(k, 40, 130, 290, 110, { color: C.orange });
text(k, 185, 164, '결제 승인', { size: 18, weight: 700 });
lines(k, 185, 206, ['PG를 부른다', '응답까지 워커 하나를 5초 붙잡는다'], { size: 14, gap: 23 });

box(k, 40, 265, 290, 110, { color: C.gray });
text(k, 185, 299, '상품 조회', { size: 18, weight: 700 });
lines(k, 185, 341, ['PG와 무관하다', '평시 p95 8ms'], { size: 14, gap: 23 });

box(k, 40, 400, 290, 110, { color: C.blue });
text(k, 185, 434, '토스 웹훅 수신', { size: 18, weight: 700 });
lines(k, 185, 476, ['PG를 안 부르고 저장 후 200', '10초 안에 2xx 못 주면 재전송'], { size: 14, gap: 23 });

// 공유 자원
box(k, 430, 230, 230, 180, { color: C.purple });
text(k, 545, 290, '톰캣 워커', { size: 20, weight: 700 });
text(k, 545, 330, '최대 100개', { size: 17, weight: 600 });
lines(k, 545, 372, ['점유 수 = 도착률 × 응답시간', '50/s × 5s = 250 > 100'], { size: 13, gap: 21, fill: '#495057' });

arrow(k, 335, 185, 425, 280, { color: C.orange.s });
arrow(k, 335, 320, 425, 320, { color: C.gray.s });
arrow(k, 335, 455, 425, 360, { color: C.blue.s });

// 결과 둘
box(k, 760, 125, 600, 205, { color: C.red });
text(k, 1060, 160, 'PG 동시 호출 상한 없음', { size: 19, weight: 700, fill: C.red.s });
lines(k, 1060, 245, [
  '워커가 최대치 100에 붙는다',
  '조회 p95 14,080ms',
  '웹훅 p95 13,056ms · 26.1%가 10초를 넘는다',
  '웹훅 527건 중 68건은 저장조차 안 됐다',
], { size: 15, gap: 26 });

box(k, 760, 350, 600, 170, { color: C.green });
text(k, 1060, 386, 'PG 동시 호출 상한 40', { size: 19, weight: 700, fill: C.green.s });
lines(k, 1060, 455, [
  '결제의 84%를 PG에 보내기 전에 거절한다',
  '조회 p95 7ms',
  '웹훅 p95 9ms · 10초 초과 0%',
], { size: 15, gap: 26 });

arrow(k, 665, 290, 755, 220, { color: C.red.s });
arrow(k, 665, 350, 755, 435, { color: C.green.s });

box(k, 250, 555, 900, 64, { color: C.yellow });
text(k, 700, 594, '거절률 = 1 − 상한 ÷ (도착률 × 지연) = 1 − 40 ÷ (50 × 5) = 84.0%   ·   실측 84.0%', { size: 16, weight: 700 });
writeFileSync(process.argv[2], render(k));
