"""키가 파티션에 어떻게 나뉘는지, 파티션 수를 늘리면 무엇이 바뀌는지 본다.

Kafka 기본 파티셔너와 같은 murmur2 해시를 쓴다(murmur2.py, Kafka 단위 테스트 값과 일치 확인).
"""
from collections import Counter

from murmur2 import partition_for

users = [f"user-{i}" for i in range(10_000)]

# 1) 파티션 6개에 키 1만 개가 얼마나 고르게 나뉘는지
counts = Counter(partition_for(u, 6) for u in users)
print("파티션 6개에 나뉜 키 수:", [counts[p] for p in range(6)])

# 2) 같은 키는 항상 같은 파티션이다. 한 사용자의 이벤트 순서는 그 파티션 안에서 지켜진다
print("user-42의 파티션(6개 기준):", partition_for("user-42", 6))

# 3) 파티션을 6개에서 8개로 늘리면 키의 몇 %가 다른 파티션으로 가는지
moved = sum(partition_for(u, 6) != partition_for(u, 8) for u in users)
print(f"6개→8개로 늘렸을 때 파티션이 바뀐 키: {moved}개 ({moved / len(users):.1%})")
moved12 = sum(partition_for(u, 6) != partition_for(u, 12) for u in users)
print(f"6개→12개로 늘렸을 때 파티션이 바뀐 키: {moved12}개 ({moved12 / len(users):.1%})")

# 4) 컨슈머 그룹: 파티션 하나는 그룹 안에서 컨슈머 하나만 읽는다
for consumers in [3, 6, 8]:
    owned = Counter(p % consumers for p in range(6))   # 단순 라운드로빈 배정
    idle = consumers - len(owned)
    print(f"파티션 6개, 컨슈머 {consumers}개: 컨슈머별 파티션 수 {[owned[c] for c in range(consumers)]}, 노는 컨슈머 {idle}개")
