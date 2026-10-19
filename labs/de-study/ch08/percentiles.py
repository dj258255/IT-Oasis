"""평균, 백분위, 백분위의 평균, 팬아웃을 숫자로 본다(seed 고정)."""
import random
import statistics

random.seed(1)


def pct(xs, p):
    """nearest-rank 백분위"""
    s = sorted(xs)
    k = max(0, min(len(s) - 1, int(round(p / 100 * len(s) + 0.5)) - 1))
    return s[k]


def summary(name, xs):
    print(f"{name:<22} 평균 {statistics.mean(xs):7.1f}  p50 {pct(xs, 50):7.1f}  p95 {pct(xs, 95):7.1f}"
          f"  p99 {pct(xs, 99):7.1f}  p99.9 {pct(xs, 99.9):7.1f}  max {max(xs):7.1f}  (ms)")


# 1) 평균이 같은데 꼬리가 다른 두 서버
a = [random.gauss(50, 5) for _ in range(10_000)]                                   # 고르게 50ms 근처
b = [random.gauss(40, 4) if random.random() < 0.98 else random.uniform(400, 600)    # 98%는 빠르고 2%가 아주 느림
     for _ in range(10_000)]
summary("서버 A(고른 지연)", a)
summary("서버 B(꼬리가 긴 지연)", b)

# 2) 1분마다 p99를 구해 평균 내면 전체 p99와 다르다
windows = []
for minute in range(10):
    slow = minute in (3, 7)                                 # 10분 중 2분만 부하가 몰린다
    n = 3000 if slow else 1000
    windows.append([random.gauss(200 if slow else 40, 20) for _ in range(n)])
avg_of_p99 = statistics.mean(pct(w, 99) for w in windows)
all_p99 = pct([x for w in windows for x in w], 99)
print(f"\n1분별 p99의 평균 {avg_of_p99:.1f}ms, 10분 전체의 p99 {all_p99:.1f}ms")

# 3) 팬아웃: 요청 하나가 백엔드 N개를 모두 기다리면 그중 하나라도 p99보다 느릴 확률
for n in [1, 10, 100]:
    print(f"백엔드 {n:>3}개를 기다리는 요청이 p99 꼬리를 한 번 이상 만날 확률 {1 - 0.99 ** n:.1%}")
