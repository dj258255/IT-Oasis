import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 615);
text(k, 700, 46, "모델 서버가 요청 본문을 빈 것으로 읽었다", { size: 24, weight: 700 });
text(k, 700, 80, "H&M 홀드아웃 주 · 고객 5,000명 · 앱의 추천 경로로 12개 받아 MAP@12", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "앱이 보낸 요청", ["구매 이력 100건을 담은 JSON", "", "길이 없이 chunked로 보냈다"]);
panel(490, 120, 420, 220, C.red, "모델 서버가 읽은 것", ["Content-Length만 읽어 본문 0바이트", "", "모두를 이력 없는 사용자로 생성", "MAP@12 0.000504 (오프라인의 2%)"]);
panel(940, 120, 420, 220, C.green, "고친 뒤", ["길이를 붙여 보낸다", "서버는 chunked도 읽고 이력 없으면 400", "", "서빙 = 오프라인 0.023295", "혼합 0.026373"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "같은 결함이 ch44의 숫자에도", ["홈 2쪽 p95 86~94ms → 80 · 100 · 121ms", "모델 행 685개 → 720개", "", "디코딩 방식에 따라 지연이 달라졌다"], 15, 29);
panel(720, 380, 640, 270, C.blue, "왜 서빙과 오프라인을 맞춰 봤나", ["오프라인 기준은 서빙과 같은 모델 서버 코드", "차이는 앱 경로에서만 생긴다", "", "서빙 경로로 채점해서 드러났다"], 15, 29);
writeFileSync(process.argv[2], render(k));
