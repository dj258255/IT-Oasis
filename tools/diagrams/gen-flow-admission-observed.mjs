import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 590);
text(k, 700, 46, "모델 지연을 잘못 알면 대기 예산이 샌다", { size: 24, weight: 700 });
text(k, 700, 80, "스텁 모델 4동시 · 50ms(초당 80건) · 부하 2배와 4배 · 대기 예산 100ms", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "대기 예산 게이트", ["지금 줄에 서면 얼마나 기다릴까", "", "예산을 넘으면 줄에 세우지 않고", "인기 상품으로 바로 답한다"]);
panel(490, 120, 420, 220, C.red, "설정값으로 추정", ["모델이 실제로 두 배 느리면", "대기를 절반으로 보고 줄을 두 배로 받는다", "", "p95 315ms (판정선 300ms)"]);
panel(940, 120, 420, 220, C.green, "끝난 호출 수로 추정", ["최근 2초에 끝난 모델 호출 수", "대기 = 줄 길이 ÷ 초당 끝난 수", "", "p95 193ms (판정선 240ms)"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "예산을 바꾸면", ["예산 50 · 100 · 200ms → p95 111 · 168 · 281ms", "개인화 비율은 예산과 무관 (44.5% · 22.6%)", "줄 상한 48은 대기 상한 400ms에 먼저 걸렸다", "모델 속도를 제대로 알 때 168 → 153ms"], 15, 29);
panel(720, 380, 640, 270, C.blue, "호출 시간을 쓰지 않은 이유", ["호출 시간에는 모델 앞 대기가 섞인다", "줄이 길수록 더 거절하는 되먹임", "", "설계대로의 기본 정책이 설정에 없었다 → 맞췄다"], 15, 29);
writeFileSync(process.argv[2], render(k));
