"""데이터 도착을 기다리는 세 방식의 비용과 지연을 센다.

30일 동안 매일 01:00~05:00 사이 무작위 시각에 주문 파일이 도착한다(seed 고정).
센서는 00:00부터 5분마다 확인하고, 확인 한 번은 1초가 걸린다고 친다.
"""
import random

random.seed(1)
DAYS = 30
INTERVAL = 5 * 60          # 확인 주기 5분
CHECK_COST = 1             # 확인 한 번 1초

arrivals = [random.uniform(1 * 3600, 5 * 3600) for _ in range(DAYS)]   # 자정부터 초

def polling(arrival):
    found_at = (int(arrival // INTERVAL) + 1) * INTERVAL   # 도착 뒤 첫 확인 시각
    checks = found_at // INTERVAL + 1                      # 00:00의 첫 확인부터 found_at까지 센다
    return checks, found_at - arrival, found_at

poke_slot, resched_slot, delays, checks_total = 0, 0, [], 0
for a in arrivals:
    checks, delay, found_at = polling(a)
    checks_total += checks
    delays.append(delay)
    poke_slot += found_at                     # poke: 워커 슬롯을 처음부터 찾을 때까지 잡고 있다
    resched_slot += checks * CHECK_COST       # reschedule: 확인하는 동안만 잡는다

print(f"하루 평균 확인 횟수(poke, reschedule 같음): {checks_total / DAYS:.1f}회")
print(f"발견 지연 평균 {sum(delays) / DAYS / 60:.1f}분, 최대 {max(delays) / 60:.1f}분")
print(f"워커 슬롯 점유 하루 평균: poke {poke_slot / DAYS / 3600:.1f}시간, reschedule {resched_slot / DAYS:.0f}초")
print("이벤트 트리거: 확인 0회, 지연은 이벤트 전달 시간뿐(이 시뮬레이션에서는 재지 않음)")
