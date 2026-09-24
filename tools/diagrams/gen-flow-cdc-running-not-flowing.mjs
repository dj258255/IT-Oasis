import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 640);
text(k, 700, 46, "상태는 RUNNING인데 흐름은 멈춰 있었다", { size: 24, weight: 700 });
text(k, 700, 80, "Debezium 카탈로그 커넥터 · DB 연결 차단과 pause를 넣어 두 지표를 비교", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "DB 연결을 5분 막는다", ["toxiproxy로 MySQL 연결 차단", "", "Connect 상태: 내내 RUNNING", "상태 지표: 내내 1"]);
panel(490, 120, 420, 220, C.red, "상태만 보면", ["5분을 통째로 놓친다", "", "pause는 상태 지표가", "11초 만에 잡는다"]);
panel(940, 120, 420, 220, C.green, "하트비트 나이를 같이 본다", ["커넥터가 찍은 마지막 하트비트의 나이", "막은 지 39초 만에 60초 초과", "", "두 지표가 서로 다른 장애를 잡는다"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "poll 간격의 비용", ["100ms · 지연 p95 97ms · Connect CPU 변경 중 7.7~10%", "1000ms · 지연 p95 953ms · Connect CPU 2.8~4%", "MySQL CPU는 간격과 거의 같다 (8.1~9.7%)", "→ 100ms 유지"], 15, 29);
panel(720, 380, 640, 270, C.blue, "남은 여유", ["조용할 때 하트비트 최대 나이 51초", "문턱 60초와의 여유 9초", "", "조용할 때 간격을 무엇이 정하는지 모른다"], 15, 29);
writeFileSync(process.argv[2], render(k));
