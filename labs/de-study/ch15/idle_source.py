"""파티션 하나가 조용해지면 전체 watermark가 멈추는 것을 본다.

파티션 A는 0~120초 내내 이벤트가 오고, 파티션 B는 30초 이후 아무것도 오지 않는다.
연산자의 watermark는 입력 파티션 watermark 중 가장 작은 값이다. 허용치 1초, 10초 윈도.
idleness를 5초로 주면 5초 동안 아무것도 안 온 파티션은 계산에서 뺀다.
"""
def run(idleness):
    wm = {"A": float("-inf"), "B": float("-inf")}
    last_seen = {"A": 0.0, "B": 0.0}
    fired = 0
    for t10 in range(0, 1201):                 # 0.1초 단위 처리 시각 = 이벤트 시각(지연 없음)
        t = t10 / 10
        wm["A"], last_seen["A"] = t - 1, t
        if t <= 30:
            wm["B"], last_seen["B"] = t - 1, t
        active = [p for p in wm if idleness is None or t - last_seen[p] < idleness]
        watermark = min(wm[p] for p in active) if active else max(wm.values())
        while watermark >= (fired + 1) * 10:
            fired += 1
    return fired


print(f"idleness 없음: 120초 동안 결과를 낸 윈도 {run(None)}개")
print(f"idleness 5초:  120초 동안 결과를 낸 윈도 {run(5)}개")
