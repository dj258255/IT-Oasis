import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 620);

marker(k, 700, 46, 540);
text(k, 700, 46, '느렸던 것은 CDC가 아니라 적지 않은 기본값이었다', { size: 26, weight: 700 });
text(k, 700, 80, '같은 활동 로그를 같은 토픽·같은 컨슈머로 받고, 누가 토픽에 넣는지만 바꿨다 · 대기 100ms · 로컬 단일 장비', { size: 14, fill: '#868e96' });

box(k, 40, 120, 410, 250, { color: C.gray });
text(k, 245, 156, '아웃박스 (앱이 발행)', { size: 18, weight: 700 });
lines(k, 245, 250, ['lag p95 14ms', '반영률 100.0%', '', '앱의 쓰기 경로가 브로커에 붙는다'], { size: 15, gap: 27 });

box(k, 495, 120, 410, 250, { color: C.red });
text(k, 700, 156, 'CDC · 설정 기본값', { size: 18, weight: 700, fill: C.red.s });
lines(k, 700, 250, ['lag p95 1,944ms (139배)', '반영률 19.5%', '', '커넥터 설정 36개 중 지연 관련은 하나도 안 적었다'], { size: 15, gap: 27 });

box(k, 950, 120, 410, 250, { color: C.green });
text(k, 1155, 156, 'CDC · 세 값을 명시', { size: 18, weight: 700, fill: C.green.s });
lines(k, 1155, 250, ['lag p95 13ms', '반영률 98.5%', '', 'poll.interval.ms 500 → 100', 'max.batch.size 2048 → 256 · max.queue.size 8192 → 1024'], { size: 14, gap: 25 });

arrow(k, 910, 245, 945, 245, { color: '#495057' });

box(k, 40, 410, 1320, 180, { color: C.yellow });
text(k, 700, 446, '상태만 보면 정상이던 조용한 실패 둘', { size: 18, weight: 700 });
lines(k, 700, 515, [
  '첫 CDC 측정은 반영률 0.0%였다. 커넥터는 정상이고 토픽에 103건이 쌓였고 앱 오류 로그는 0건이었다',
  '컨슈머 빈이 "전달 방식 = KAFKA"일 때만 만들어지는 조건이라 CDC 모드에서는 읽는 쪽이 아예 없었다',
  '커넥터가 RUNNING인 채 안에서 재시작만 돌던 것도 있었다 (MySQL 8.4 비호환)',
], { size: 14.5, gap: 28 });
writeFileSync(process.argv[2], render(k));
