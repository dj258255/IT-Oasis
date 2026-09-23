import { canvas, box, text, lines, line, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 640);

marker(k, 700, 46, 520);
text(k, 700, 46, '재 보고 넣지 않은 두 가지', { size: 27, weight: 700 });
text(k, 700, 80, '추천 모듈 · 서빙 계약(ModelClient)은 그대로 두고 잰 값', { size: 15, fill: '#868e96' });

// 왼쪽: MAP@12 막대
text(k, 350, 132, '학습한 ALS 모델: 선을 먼저 정하고 쟀다', { size: 18, weight: 700 });
text(k, 350, 158, 'H&M 거래 3,154만 행 · 홀드아웃 7일 · 평가 고객 68,984명 · MAP@12', { size: 13, fill: '#868e96' });
const X0 = 250, W = 360 / 0.0234;   // 0.0234 가 360px
const bars = [
  ['마지막 구매 재추천', 0.023354, C.green, '0.0234 (선)'],
  ['최근 7일 인기', 0.008748, C.gray, '0.0087'],
  ['ALS 최고 구성', 0.007608, C.orange, '0.0076'],
  ['ALS · 산 것 제외', 0.004104, C.red, '0.0041'],
  ['전체 인기', 0.002899, C.gray, '0.0029'],
];
bars.forEach(([label, v, color, val], i) => {
  const y = 190 + i * 58;
  text(k, X0 - 14, y + 23, label, { size: 14.5, weight: 600, anchor: 'end' });
  box(k, X0, y, Math.max(18, v * W), 36, { color, r: 8 });
  text(k, X0 + v * W + 12, y + 23, val, { size: 14, weight: 600, anchor: 'start' });
});
line(k, X0 + 360, 180, X0 + 360, 480, { color: C.green.s, width: 1.6 });
lines(k, 350, 515, ['ALS 네 구성 최고가 선의 3분의 1, 인기보다도 낮다', 'alpha·factors 두 축으로 얻은 폭 15% 미만 · 선까지 207%'], { size: 14, gap: 24, weight: 600 });

line(k, 720, 120, 720, 600, { color: '#dee2e6' });

// 오른쪽: 생성 중 차단
text(k, 1050, 132, '품절 상품을 생성 중에 막기', { size: 18, weight: 700 });
text(k, 1050, 158, '실 카탈로그 105,545개 · 목록 12개', { size: 13, fill: '#868e96' });

box(k, 760, 190, 280, 250, { color: C.green });
text(k, 900, 224, '생성 뒤에 거르기 (유지)', { size: 16, weight: 700, fill: C.green.s });
lines(k, 900, 320, ['출력 12개를 한 번에 확인', '', '12개를 다 채운 비율 100%', '서빙 중앙값 62ms', 'coverage 100%'], { size: 14.5, gap: 25 });

box(k, 1070, 190, 290, 250, { color: C.red });
text(k, 1215, 224, '생성 중에 막기 (기각)', { size: 16, weight: 700, fill: C.red.s });
lines(k, 1215, 320, ['후보 하나마다 확인', '', '12개를 다 채운 비율 93.3%', '서빙 중앙값 369ms (재현 437ms)', 'coverage 93.3% (재현 84.5%)'], { size: 14.5, gap: 25 });

lines(k, 1060, 515, ['막으려던 "목록이 짧아지는 문제"가 이 카탈로그에는 없었다', '느려진 모델 호출이 과부하 정책을 건드려 개인화를 못 받는 요청이 생겼다'], { size: 14, gap: 24, weight: 600 });

box(k, 250, 570, 900, 50, { color: C.yellow });
text(k, 700, 601, '둘 다 코드는 남기고 기본값은 켜지 않았다 · ModelClient 계약은 한 글자도 안 바뀌었다', { size: 15.5, weight: 700 });
writeFileSync(process.argv[2], render(k));
