"""서버가 30초 동안 죽어 있을 때 지수 백오프 재시도가 어떻게 몰리는지 센다.

사용법: python backoff_jitter.py            # 세 방식을 모두 비교
       python backoff_jitter.py full       # 하나만
"""
import random
import sys
from collections import Counter

CLIENTS = 1000
RECOVER_AT = 30.0      # 서버는 30초 동안 죽어 있다가 살아난다
BASE, CAP = 1.0, 60.0


def next_delay(mode, attempt):
    delay = min(CAP, BASE * 2 ** attempt)
    if mode == "full":
        return random.uniform(0, delay)
    if mode == "equal":
        return delay / 2 + random.uniform(0, delay / 2)
    return delay                       # none: 지터 없음


def simulate(mode):
    """클라이언트 1000개가 0초에 동시에 실패하고 재시도한다."""
    random.seed(1)
    retries = Counter()      # 서버가 죽어 있는 동안의 재시도
    first_ok = Counter()     # 서버가 살아난 뒤 처음 들어온 요청
    for _ in range(CLIENTS):
        t, attempt = 0.0, 0
        while t < RECOVER_AT:
            t += next_delay(mode, attempt)
            attempt += 1
            if t < RECOVER_AT:
                retries[int(t)] += 1
        first_ok[int(t)] += 1
    return retries, first_ok


modes = sys.argv[1:] or ["none", "full", "equal"]
for mode in modes:
    retries, first_ok = simulate(mode)
    peak_sec = max(first_ok, key=first_ok.get)
    print(f"[{mode}]")
    print(f"  죽어 있는 동안 재시도 {sum(retries.values())}건, 1초에 가장 많이 몰린 재시도 {max(retries.values())}건")
    print(f"  살아난 뒤 1초에 가장 많이 몰린 요청 {first_ok[peak_sec]}건 ({peak_sec}초)")
    print(f"  마지막 클라이언트가 성공한 시각 {max(first_ok)}초")
