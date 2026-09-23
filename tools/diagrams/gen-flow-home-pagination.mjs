import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 620);

marker(k, 700, 46, 600);
text(k, 700, 46, '다음 쪽은 앞 쪽과 그 사이의 세션을 입력으로 받는다', { size: 26, weight: 700 });
text(k, 700, 80, 'GenPage 의 paginated recommendation 을 홈에 넣었다 · 사용자 30명 실측', { size: 15, fill: '#868e96' });

box(k, 40, 130, 300, 200, { color: C.gray });
text(k, 190, 164, '1쪽', { size: 20, weight: 700 });
lines(k, 190, 245, ['최근 본 상품 · 추천 · 인기', '', 'nextCursor 에', '보여 준 상품 id 를 싣는다', '(120자)'], { size: 14.5, gap: 25 });

box(k, 420, 150, 260, 160, { color: C.orange });
text(k, 550, 184, '그 사이 세션', { size: 18, weight: 700, fill: C.orange.s });
lines(k, 550, 250, ['사용자가 아동복을 본다', '', '다음 요청 때 최근 활동을', '다시 읽는다'], { size: 14.5, gap: 24 });

box(k, 760, 130, 600, 200, { color: C.green });
text(k, 1060, 164, '2쪽 · 대분류 행', { size: 20, weight: 700, fill: C.green.s });
lines(k, 1060, 250, [
  '첫 행 = 방금 본 대분류 (CATEGORY_POPULAR_SESSION)',
  '커서의 상품은 빼고 만든다',
  '인기 표에 없는 대분류는 신상품으로 채운다',
  'nextCursor 395자 · 3쪽에서 끝',
], { size: 14.5, gap: 26 });

arrow(k, 345, 230, 415, 230, { color: '#495057' });
arrow(k, 685, 230, 755, 230, { color: '#495057' });

box(k, 40, 370, 640, 210, { color: C.blue });
text(k, 360, 406, '실측 (기본값 IN_PROCESS)', { size: 18, weight: 700, fill: C.blue.s });
lines(k, 360, 490, [
  '세션 반영: 대기 0ms 96.7% · 50ms 100%',
  '쪽 사이 중복: 커서 있음 0 · 없음 2쪽 평균 8.6개',
  '다음 쪽 p95 81~86ms',
], { size: 15, gap: 30 });

box(k, 720, 370, 640, 210, { color: C.red });
text(k, 1040, 406, '1차 60%: 놓친 12건의 원인은 둘', { size: 18, weight: 700, fill: C.red.s });
lines(k, 1040, 490, [
  '6건: 평가 스크립트가 대분류 NULL 을 대상으로 골랐다',
  '6건: 인기 표에 아동복이 0개라 행이 서지 않았다',
  '오류는 없었고 세션 신호만 조용히 버려졌다',
], { size: 15, gap: 30 });
writeFileSync(process.argv[2], render(k));
