"""서버가 1초 멈췄을 때 부하 생성기 방식에 따라 기록되는 지연이 얼마나 다른지 본다.

서버: 요청 하나를 1ms에 처리한다. 5.0초부터 6.0초까지 1초 동안 멈춘다(GC 같은 정지).
목표 부하: 10ms마다 요청 하나(초당 100건), 10초 동안.
"""
STALL_START, STALL_END = 5.0, 6.0
SERVICE = 0.001
INTERVAL = 0.010
DURATION = 10.0


def serve(arrive, free_at):
    """도착 시각과 서버가 비는 시각으로 응답 시각을 구한다."""
    start = max(arrive, free_at)
    if STALL_START <= start < STALL_END:
        start = STALL_END
    return start + SERVICE


def pct(xs, p):
    s = sorted(xs)
    return s[min(len(s) - 1, int(p / 100 * len(s)))]


def closed_loop():
    """응답을 받아야 다음 요청을 보낸다. 늦어진 만큼 보낼 요청을 건너뛴다(흔한 부하 도구 방식)."""
    lat, t, free = [], 0.0, 0.0
    while t < DURATION:
        done = serve(t, free)
        free = done
        lat.append((done - t) * 1000)
        nxt = t + INTERVAL
        t = nxt if done <= nxt else done            # 밀린 요청은 보내지 않는다
    return lat


def open_loop():
    """응답과 상관없이 10ms마다 보낸다. 지연은 보내기로 한 시각부터 잰다."""
    lat, free = [], 0.0
    for i in range(int(DURATION / INTERVAL)):
        t = i * INTERVAL
        done = serve(t, free)
        free = done
        lat.append((done - t) * 1000)
    return lat


def corrected(closed):
    """HdrHistogram의 recordValueWithExpectedInterval처럼, 긴 지연 하나 뒤에 빠진 요청들을 채워 넣는다."""
    out = []
    for v in closed:
        out.append(v)
        missing = v - INTERVAL * 1000
        while missing > 0:
            out.append(missing)
            missing -= INTERVAL * 1000
    return out


for name, lat in [("closed loop", closed_loop()), ("closed loop + 보정", corrected(closed_loop())), ("open loop", open_loop())]:
    print(f"{name:<18} 기록 {len(lat):>5}건  p50 {pct(lat, 50):7.1f}  p99 {pct(lat, 99):7.1f}  p99.9 {pct(lat, 99.9):7.1f}  max {max(lat):7.1f} (ms)")
