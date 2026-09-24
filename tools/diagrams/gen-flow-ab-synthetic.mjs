import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 690);
text(k, 700, 46, "A/B 실험 기반을 합성 사용자로 끝에서 끝까지", { size: 24, weight: 700 });
text(k, 700, 80, "합성 사용자 1,000명 · 홈 1쪽 3번씩 · 행동은 정한 확률 · 추천 품질에 대한 주장이 아니다", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "배정", ["SHA-256(솔트:사용자 id)", "앞 4바이트 % 10,000", "", "배정 표를 저장하지 않는다", "고정 배정 위반 0 / 3,000 방문"]);
panel(490, 120, 420, 220, C.blue, "노출 기록", ["홈 1쪽 응답과 노출 표에", "실험 이름 · 변형을 남긴다", "", "응답이 곧 노출"]);
panel(940, 120, 420, 220, C.green, "귀속과 분석", ["노출에 있던 상품만 귀속", "클릭 30분 · 구매 24시간", "", "SRM 검정 · 차이의 95% 구간"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "A/A와 주입 A/B", ["A/A 클릭 차이 −0.002 [−0.051, +0.047]", "주입 +0.10 → +0.062 [+0.010, +0.115]", "주입 +0.03 → 구매 +0.033 [+0.005, +0.060]", "실현된 차이가 정확히 0.062였다"], 15, 29);
panel(720, 380, 640, 270, C.red, "음성 대조", ["노출되지 않은 상품의 클릭 · 구매를 섞었다", "", "귀속 = 정답 (클릭 195 · 239, 구매 45 · 51)", "섞은 것은 한 건도 세지 않았다"], 15, 29);
writeFileSync(process.argv[2], render(k));
