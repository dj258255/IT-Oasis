import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 620);

marker(k, 700, 46, 600);
text(k, 700, 46, '늦게 온 이벤트를 버리지 않고 제자리에 넣었다', { size: 26, weight: 700 });
text(k, 700, 80, '같은 활동 로그로 온라인 컨텍스트와 오프라인 재계산을 만들어 대조했다 · 합성 로그 · 로컬', { size: 15, fill: '#868e96' });

box(k, 40, 120, 640, 250, { color: C.red });
text(k, 360, 156, '전: 들어온 seq가 현재보다 크지 않으면 버린다', { size: 18, weight: 700, fill: C.red.s });
lines(k, 360, 262, [
  '순서가 뒤집혀 도착한 이벤트는 영구히 사라진다',
  '로그에는 남는데 컨텍스트에는 없다',
  '',
  '순서 역전 주입: 일치율 0.0% (20명 전원)',
  '인프로세스 전달: 33.3%',
], { size: 15, gap: 27 });

box(k, 720, 120, 640, 250, { color: C.green });
text(k, 1040, 156, '후: 적용된 seq 집합에서 큰 것 N개', { size: 18, weight: 700, fill: C.green.s });
lines(k, 1040, 262, [
  '낮은 seq도 그 자리에 끼워 넣는다',
  '같은 seq가 있으면 쓰지 않는다 (재배달 멱등)',
  '',
  '순서 역전 주입: 100.0%',
  '인프로세스 전달: 100.0%',
], { size: 15, gap: 27 });
arrow(k, 684, 245, 716, 245, { color: '#495057' });

box(k, 40, 400, 640, 180, { color: C.orange });
text(k, 360, 436, '목록으로 세던 창 집계', { size: 18, weight: 700, fill: C.orange.s });
lines(k, 360, 510, [
  '목록은 최근 20개로 자른다. 그 목록 길이로 "최근 몇 번"을 셌다',
  '활동 30건인 사용자: 목록 100% 일치, 집계 60% 일치',
  '재는 도구도 같은 잘림을 물려받고 있었다',
], { size: 14.5, gap: 27 });

box(k, 720, 400, 640, 180, { color: C.blue });
text(k, 1040, 436, '세는 일에는 세는 그릇', { size: 18, weight: 700, fill: C.blue.s });
lines(k, 1040, 510, [
  '유형별 카운터를 같은 값·같은 Lua 안에서 갱신',
  '잘리지 않고 순서에도 무관 → 집계 60% → 100%',
  '대가: 창이 슬라이딩이 아니라 TTL(7일) 경계',
], { size: 14.5, gap: 27 });
writeFileSync(process.argv[2], render(k));
