"""linger.ms와 batch.size가 요청 수와 배치 대기 시간을 어떻게 바꾸는지 단순 모델로 센다.

가정
- 1KB 메시지가 초당 R건, 무작위 간격(포아송)으로 10초 동안 들어온다(seed 고정).
- batch.size 16384바이트라 배치 하나에 메시지 16개가 차면 바로 보낸다.
- 배치의 첫 메시지가 들어온 뒤 linger.ms가 지나면 차지 않았어도 보낸다.
- 실제 프로듀서는 보내고 응답을 기다리는 동안에도 메시지를 모은다. 이 모델은 그 효과를 넣지 않았다.
"""
import random

MSG = 1024
BATCH = 16384
PER_BATCH = BATCH // MSG
SECONDS = 10


def run(rate, linger_ms):
    random.seed(1)
    t, arrivals = 0.0, []
    while t < SECONDS:
        t += random.expovariate(rate)
        arrivals.append(t)
    linger = linger_ms / 1000
    waits, requests, batch = [], 0, []
    for a in arrivals:
        if batch and a - batch[0] >= linger:          # linger가 지난 배치를 먼저 보낸다
            send_at = batch[0] + linger
            waits += [send_at - x for x in batch]
            requests += 1
            batch = []
        batch.append(a)
        if len(batch) == PER_BATCH:                   # 꽉 차면 바로 보낸다
            waits += [a - x for x in batch]
            requests += 1
            batch = []
    if batch:
        waits += [batch[0] + linger - x for x in batch]
        requests += 1
    waits.sort()
    p99 = waits[int(0.99 * len(waits))] * 1000
    return requests / SECONDS, sum(waits) / len(waits) * 1000, p99, len(arrivals) / requests


print(f"{'초당 메시지':>10} {'linger.ms':>9} {'초당 요청':>9} {'요청당 메시지':>12} {'평균 대기':>9} {'p99 대기':>9}")
for rate in [100, 1_000, 10_000]:
    for linger in [0, 5, 20]:
        rps, avg, p99, per = run(rate, linger)
        print(f"{rate:>10} {linger:>9} {rps:>9.0f} {per:>12.1f} {avg:>7.2f}ms {p99:>7.2f}ms")
