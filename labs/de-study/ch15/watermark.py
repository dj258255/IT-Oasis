"""watermark 지연 허용치(bounded out-of-orderness)에 따라 버려지는 늦은 데이터와 결과가 나오는 지연이 어떻게 바뀌는지 센다.

- 이벤트 시각 0~600초에 이벤트 6,000개(초당 10개). 각 이벤트는 0.3초 평균의 지수분포로 늦게 도착하고, 2%는 3~8초 늦는다(seed 고정).
- 10초짜리 텀블링 윈도. watermark = 지금까지 본 가장 늦은 이벤트 시각 - 허용치.
- watermark가 윈도 끝을 넘으면 결과를 내보낸다. 그 뒤에 도착한 그 윈도 이벤트는 버린다(Flink 기본 동작).
"""
import random

WINDOW = 10.0


def events():
    random.seed(1)
    out = []
    for i in range(6000):
        et = i * 0.1
        delay = random.uniform(3, 8) if random.random() < 0.02 else random.expovariate(1 / 0.3)
        out.append((et + delay, et))       # (도착 시각, 이벤트 시각)
    return sorted(out)


def run(bound):
    max_et, fired, dropped, latencies = float("-inf"), set(), 0, []
    for arrival, et in events():
        w = int(et // WINDOW)
        if w in fired:
            dropped += 1                    # 이미 결과를 낸 윈도의 이벤트
            continue
        max_et = max(max_et, et)
        watermark = max_et - bound
        nxt = min((x for x in range(0, 61) if x not in fired), default=None)
        while nxt is not None and watermark >= (nxt + 1) * WINDOW:
            fired.add(nxt)
            latencies.append(arrival - (nxt + 1) * WINDOW)   # 윈도 끝부터 결과가 나온 시각까지
            nxt = min((x for x in range(0, 61) if x not in fired), default=None)
    return dropped, sum(latencies) / len(latencies)


print(f"{'허용치':>6} {'버려진 늦은 이벤트':>14} {'결과 지연 평균':>12}")
for bound in [0, 0.5, 1, 2, 5, 10]:
    dropped, lat = run(bound)
    print(f"{bound:>5}s {dropped:>11}개 ({dropped / 6000:.2%}) {lat:>9.2f}s")
