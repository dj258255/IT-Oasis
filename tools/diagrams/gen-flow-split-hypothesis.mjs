import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 620);

marker(k, 700, 46, 760);
text(k, 700, 46, '분리 근거로 세운 가설 하나를 기각했고, 그 실험이 다른 결함을 드러냈다', { size: 25, weight: 700 });
text(k, 700, 80, '체크아웃 30VU 상시 부하 · 정산 배치(2만 건) 7회 연속 · 로컬 단일 장비', { size: 15, fill: '#868e96' });

box(k, 40, 120, 640, 290, { color: C.gray });
text(k, 360, 156, '가설 1: 정산 배치가 결제를 느리게 한다', { size: 19, weight: 700 });
lines(k, 360, 272, [
  '같은 JVM, 같은 커넥션 풀 20개를 쓰니까',
  '',
  '배치 없음 p95 64.3ms · p99 91.1ms',
  '배치 7연타 p95 54.1ms · p99 68.0ms',
  '커넥션 최대 사용 15개 · 대기 0',
  '',
  '미재현. 분리 근거에서 뺐다',
], { size: 15, gap: 26 });

box(k, 720, 120, 640, 290, { color: C.red });
text(k, 1040, 156, '1차 실행에서 드러난 것', { size: 19, weight: 700, fill: C.red.s });
lines(k, 1040, 272, [
  '계정 1개로 30VU → 결제 승인 70%가 500',
  '범인은 결제가 아니라 포인트 적립',
  '같은 포인트 계좌 행을 동시에 읽고 고치고 써서',
  '낙관적 락 충돌',
  '',
  '운영에서는 사용자별 요청 제한(5건/초)이',
  '이 결함을 가리고 있었다',
], { size: 15, gap: 26 });

box(k, 40, 450, 1320, 130, { color: C.green });
text(k, 700, 486, '적립은 더하기라 순서가 무관하다 → 읽지 않고 DB에서 바로 더한다', { size: 18, weight: 700, fill: C.green.s });
lines(k, 700, 540, [
  '같은 최악 조건(계정 1개 · 30VU · 제한 끔)에서 결제 승인 성공률 39.6% → 100.00% (6,761/6,761)',
  '잔액 978,400원 = 원장의 적립 − 회수 합계 978,400원 · 불일치 0',
], { size: 15, gap: 27 });
writeFileSync(process.argv[2], render(k));
