import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 600);

marker(k, 700, 46, 560);
text(k, 700, 46, '쌓인 미확정 결제가 풀리는 시간은 둘 중 하나가 정한다', { size: 26, weight: 700 });
text(k, 700, 80, 'PG 지연 5초 · read-timeout 2초로 45초 동안 미확정을 만들고, payments 테이블을 2초마다 직접 셌다', { size: 14, fill: '#868e96' });

box(k, 40, 120, 420, 260, { color: C.blue });
text(k, 250, 156, '하한: MIN_AGE 1분', { size: 20, weight: 700, fill: C.blue.s });
lines(k, 250, 262, [
  '1분보다 어린 미확정은 복구가 건드리지 않는다',
  '진행 중인 정상 요청과 겹치지 않으려는 값',
  '',
  '청크 500 · 주기 5초 · 미확정 887건',
  '첫 해소 t+18s · 전량 해소 t+61s',
  '생성 곡선을 1분 뒤로 민 모양',
], { size: 14.5, gap: 25 });

box(k, 490, 120, 420, 260, { color: C.orange });
text(k, 700, 156, '상한: 청크 ÷ 주기', { size: 20, weight: 700, fill: C.orange.s });
lines(k, 700, 262, [
  '틱마다 자격자가 청크를 넘으면 배치가 병목',
  '',
  '청크 50 · 주기 5초 = 10건/초',
  '885 → 835 → 785 … 틱마다 정확히 50',
  '계산 t+18s + 885 ÷ 10 = t+106.5s',
  '실측 t+106s',
], { size: 14.5, gap: 25 });

box(k, 940, 120, 420, 260, { color: C.green });
text(k, 1150, 156, '기본값 주기 60초 · 청크 500', { size: 20, weight: 700, fill: C.green.s });
lines(k, 1150, 262, [
  '해소율 8.3건/초',
  '',
  '500건 → 1분 (MIN_AGE만)',
  '1,351건 → 약 3.7분',
  '10,000건 → 약 20분',
  '청크를 넘으면 선형으로 길어진다',
], { size: 14.5, gap: 25 });

box(k, 40, 420, 1320, 140, { color: C.yellow });
text(k, 700, 458, '복구 중 ABORTED 0건 · 887건 전량 DONE', { size: 19, weight: 700 });
lines(k, 700, 510, [
  '가짜 PG는 타임아웃 난 요청을 실제로는 승인했다. 복구가 PG에 다시 묻지 않고 실패로 적었다면 887건이 전부 잘못된 실패였다',
  '알림은 가장 오래된 미확정의 나이에 건다. 청크가 밀리기 시작하면 그 나이가 1분을 넘어 계속 자란다',
], { size: 14.5, gap: 26 });
writeFileSync(process.argv[2], render(k));
