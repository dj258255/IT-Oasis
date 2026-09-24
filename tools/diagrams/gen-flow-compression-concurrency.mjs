import { canvas, box, text, lines, arrow, marker, render, C } from './draw.mjs';
import { writeFileSync } from 'fs';
const k = canvas(1400, 680);
const panel = (x, y, w, h, color, title, body, size = 14.5, gap = 27) => {
  box(k, x, y, w, h, { color });
  text(k, x + w / 2, y + 34, title, { size: 18, weight: 700, fill: color === C.gray ? '#212529' : color.s });
  lines(k, x + w / 2, y + 34 + (h - 34) / 2 + 6, body, { size, gap });
};
marker(k, 700, 46, 615);
text(k, 700, 46, "동시 요청이 몰릴수록 압축의 이득이 커졌다", { size: 24, weight: 700 });
text(k, 700, 80, "실제 Redis · 연결 하나 공유 · 스레드마다 200개 넣고 읽기 · 크기 × 코덱 × 스레드 1 · 8 · 32", { size: 14, fill: '#868e96' });
panel(40, 120, 420, 220, C.gray, "임계값 1KB", ["32스레드 넣고 읽기 p95", "Snappy 1.57ms · 압축 없음 1.48ms", "", "1.06배 (기준 1.2배 이하)", "→ 유지"]);
panel(490, 120, 420, 220, C.blue, "코덱 Snappy", ["8 · 32스레드 연산당 CPU", "여섯 칸 중 다섯에서 Snappy < LZ4", "한 칸은 동점 (64.65µs)", "→ 유지"]);
panel(940, 120, 420, 220, C.green, "큰 값은 크게 이긴다", ["50KB · 32스레드 p95", "압축 없음 5.89ms · Snappy 2.24ms", "", "500KB 조회 p99 40.21 → 8.42ms"]);
arrow(k, 465, 230, 485, 230, { color: '#495057' });
arrow(k, 915, 230, 935, 230, { color: '#495057' });
panel(40, 380, 640, 270, C.orange, "왜", ["연결 하나 위의 명령은 차례로 나가고 돌아온다", "동시 요청이 많을수록 바이트 수가 줄을 세운다", "압축은 CPU를 더 쓰고 그 줄을 줄였다"], 15, 29);
panel(720, 380, 640, 270, C.red, "한계", ["각 조건 한 번 · 32스레드는 코어 수보다 많다", "연결 풀 구성에서는 다를 수 있다", "", "압축은 아직 켜져 있지 않다 (적용할 캐시가 없다)"], 15, 29);
writeFileSync(process.argv[2], render(k));
