import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);

marker(k, 700, 46, 640);
text(k, 700, 46, '작은 GenPage: 이력을 프롬프트로 행을 생성하고, 규칙은 마스크로 지킨다', { size: 24, weight: 700 });
text(k, 700, 80, 'H&M 구매 3,154만 건 · 어휘 82,759 · causal transformer 2층 5.4M · 사전학습만(후학습 없음)', { size: 14, fill: '#868e96' });

box(k, 40, 120, 300, 220, { color: C.gray });
text(k, 190, 154, '프롬프트', { size: 19, weight: 700 });
lines(k, 190, 245, ['최근 구매 50개', '(상품 토큰 시퀀스)', '', '+ 앞 쪽에서 보여 준 상품', '+ 이미 쓴 대분류'], { size: 14.5, gap: 25 });

box(k, 400, 120, 560, 220, { color: C.blue });
text(k, 680, 154, '행 하나를 만드는 순서', { size: 19, weight: 700, fill: C.blue.s });
lines(k, 680, 250, [
  '① 다음 상품 분포를 대분류별로 합쳐 행을 고른다',
  '② 앞 2개는 한 칸씩 생성하고 문맥에 붙인다',
  '③ 나머지 6개는 마지막 분포에서 한 번에 고른다',
  '매 단계 마스크: 이미 나온 상품 · 앞 쪽 상품 · 다른 대분류',
  '품절은 모델이 모른다 → 앱이 생성 뒤에 거른다',
], { size: 14.5, gap: 27 });

box(k, 1020, 120, 340, 220, { color: C.green });
text(k, 1190, 154, '서빙 (홈 2쪽)', { size: 19, weight: 700, fill: C.green.s });
lines(k, 1190, 250, ['p95 86~94ms', '(규칙 행 124ms)', '', '모델 행 685개', '중복 0 · 대분류 불일치 0'], { size: 14.5, gap: 25 });

arrow(k, 345, 230, 395, 230, { color: '#495057' });
arrow(k, 965, 230, 1015, 230, { color: '#495057' });

box(k, 40, 380, 640, 270, { color: C.orange });
text(k, 360, 414, '순전파 수가 곧 비용 (3행 × 8개)', { size: 18, weight: 700, fill: C.orange.s });
lines(k, 360, 520, [
  '한 번에 고르기 · 순전파 3번 · p95 9ms',
  '하이브리드(앞 2개) · 순전파 9번 · p95 19ms',
  '전부 한 칸씩 · 순전파 27번 · p95 46ms',
  '',
  '모델 서버 직접 · CPU 2스레드 · 동시성 1',
], { size: 15, gap: 29 });

box(k, 720, 380, 640, 270, { color: C.red });
text(k, 1040, 414, '품질: 측정 전 선을 못 넘었다', { size: 18, weight: 700, fill: C.red.s });
lines(k, 1040, 520, [
  '선(마지막 구매 재추천) · MAP@12 0.0234',
  'GenPage 3차 · 0.0209 (선의 90%)',
  'ALS 최고 · 0.0076',
  '이미 산 상품을 빼면 −63% → 재구매 흉내',
  '같은 홀드아웃으로 더 고르지 않고 멈췄다 · 기본값 꺼짐',
], { size: 15, gap: 29 });
writeFileSync(process.argv[2], render(k));
