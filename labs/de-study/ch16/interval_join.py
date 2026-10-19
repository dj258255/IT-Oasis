"""주문과 결제를 interval join으로 짝지을 때, 시간 범위에 따라 짝지어지는 비율과 붙들고 있어야 하는 상태가 어떻게 바뀌는지 센다.

- 주문 1만 건이 하루 동안 고르게 들어온다(seed 고정).
- 결제는 주문의 90%에만 있고, 주문 뒤 1분 평균의 지수분포로 늦게 오며 5%는 10~40분 뒤에 온다.
- 결제 시각이 [주문 시각, 주문 시각 + 범위] 안이면 짝짓는다.
- 상태: 범위 동안은 주문을 기억해야 한다. 평균 동시 보관 수 = 초당 주문 수 × 범위.
"""
import random

random.seed(1)
N = 10_000
DAY = 86_400
orders = sorted(random.uniform(0, DAY) for _ in range(N))
pays = []
for o in orders:
    if random.random() < 0.9:
        d = random.uniform(600, 2400) if random.random() < 0.05 else random.expovariate(1 / 60)
        pays.append(d)
    else:
        pays.append(None)

paid = sum(p is not None for p in pays)
print(f"결제가 실제로 있는 주문: {paid}건")
print(f"{'범위':>6} {'짝지은 주문':>10} {'결제 있는 주문 중':>14} {'평균 보관 주문 수':>14}")
for minutes in [1, 5, 15, 60]:
    bound = minutes * 60
    joined = sum(p is not None and p <= bound for p in pays)
    state = N / DAY * bound
    print(f"{minutes:>4}분 {joined:>9}건 {joined / paid:>13.1%} {state:>13.1f}건")
