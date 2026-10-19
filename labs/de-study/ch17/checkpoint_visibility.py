"""exactly-once 싱크는 체크포인트가 끝날 때 결과를 커밋한다. 체크포인트 간격에 따라
결과가 읽는 쪽에 보이기까지의 지연과, 장애 때 다시 처리할 양이 어떻게 바뀌는지 센다.

- 레코드는 초당 1,000건이 고르게 들어온다(600초).
- 체크포인트는 간격마다 시작하고 0.5초 뒤 끝난다. 끝나는 순간 그때까지의 결과가 보인다.
- 장애는 무작위 시각에 한 번(1,000번 반복해 평균). 마지막으로 끝난 체크포인트 이후의 레코드를 다시 처리한다.
"""
import random

RATE, DURATION, CK_TIME = 1000, 600, 0.5


def visibility(interval):
    delays = []
    for i in range(RATE * DURATION):
        t = i / RATE
        k = int(t // interval) + 1                 # 이 레코드가 들어갈 다음 체크포인트
        commit = k * interval + CK_TIME
        delays.append(commit - t)
    delays.sort()
    return sum(delays) / len(delays), delays[int(0.99 * len(delays))]


def replay(interval):
    random.seed(1)
    total = 0
    for _ in range(1000):
        crash = random.uniform(interval + CK_TIME, DURATION)
        last_done = int((crash - CK_TIME) // interval) * interval    # 마지막으로 끝난 체크포인트가 담은 시각
        total += (crash - last_done) * RATE
    return total / 1000


print(f"{'간격':>5} {'보이기까지 평균':>12} {'p99':>8} {'장애 때 재처리(평균)':>16}")
for interval in [1, 10, 60]:
    avg, p99 = visibility(interval)
    print(f"{interval:>4}s {avg:>11.2f}s {p99:>7.2f}s {replay(interval):>14,.0f}건")
