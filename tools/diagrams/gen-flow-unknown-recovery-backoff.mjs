import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 715);
text(k, 700, 46, "확정 못 한 결제가 앞자리를 차지하면 뒤가 굶는다", { size: 24, weight: 700 });
text(k, 700, 80, "결과를 모르는 결제 복구 · PG가 '진행 중'이라 답하는 건 100개 + 풀리는 건 500개", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "결과를 모르는 결제", ["PG 응답을 받지 못한 시도", "", "복구 배치가 PG에 묻고", "승인 · 실패로 확정한다"]);
panel(490, 120, 420, 220, C.red, "오래된 순으로만 읽으면", ["'진행 중' 100건이 늘 앞자리", "", "뒤의 500건이 5분 동안", "한 건도 풀리지 않았다"]);
panel(940, 120, 420, 220, C.green, "다음 시도를 뒤로 미루면", ["1 · 2 · 4 · 8분 뒤 (상한 10분)", "때가 된 것 중 오래된 순", "", "500건이 60초에 풀렸다", "(막힌 건 없을 때 50초)"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "대가", ["막힌 건의 확정이 최대 10분 늦어질 수 있다", "오래된 미확정은 나이 알림이 따로 잡는다", "", "간격(1 · 2 · 4 · 8분)은 재서 고른 값이 아니다"], 15, 29);
panel(720, 380, 640, 270, C.blue, "기록하는 것", ["결제 행에 시도 횟수와 다음 시도 시각", "PG 조회가 실패한 건도 같이 미룬다", "", "정책은 설정으로 고른다 (기본 backoff)"], 15, 29);
writeFileSync(process.argv[2], render(k));
