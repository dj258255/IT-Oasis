"""같은 이벤트가 세 번 전달될 때(at-least-once) 일일 집계 run이 몇 번 도는지 센다."""
events = [
    {"id": "orders-2026-10-01", "t": 0},
    {"id": "orders-2026-10-01", "t": 1},   # 같은 이벤트 재전달
    {"id": "orders-2026-10-01", "t": 7},   # 한참 뒤 또 재전달
]
RUN_SECONDS = 5


def no_guard():
    return len(events), "run마다 새 run_id"


def max_active_runs_1():
    # 동시에 하나만 돈다. 나머지는 줄 서서 기다렸다가 결국 돈다
    return len(events), "겹치지 않게 차례로 돌 뿐 세 번 다 돈다"


def run_id_from_event():
    seen = set()
    runs = 0
    for e in events:
        run_id = f"event__{e['id']}"       # 이벤트 키로 run_id를 정한다
        if run_id in seen:
            continue                        # 이미 있는 run_id면 만들지 않는다
        seen.add(run_id)
        runs += 1
    return runs, "같은 이벤트는 같은 run_id라 한 번만 만든다"


for name, f in [("막는 장치 없음", no_guard), ("max_active_runs=1", max_active_runs_1), ("이벤트 키로 run_id", run_id_from_event)]:
    runs, why = f()
    print(f"{name:<20} run {runs}번  ({why})")
