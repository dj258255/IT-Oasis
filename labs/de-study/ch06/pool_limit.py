"""외부 API를 부르는 태스크 50개를 pool 크기별로 돌린다(1초 단위 시뮬레이션).

가정한 API: 동시 5건까지는 1초에 처리하고, 넘으면 넘친 요청에 429를 돌려준다.
429를 받은 태스크는 2초 뒤 다시 시도한다.
"""
TASKS = 50
API_CONCURRENCY = 5
RETRY_AFTER = 2


def run(pool):
    waiting = list(range(TASKS))     # 아직 슬롯을 못 받은 태스크
    ready_at = {}                    # 429 뒤 다시 시도할 수 있는 시각
    done, calls, rejected, t = 0, 0, 0, 0
    running = []                     # 슬롯을 받은 태스크
    while done < TASKS:
        while waiting and len(running) < pool:
            running.append(waiting.pop(0))
        trying = [x for x in running if ready_at.get(x, 0) <= t]
        accepted, over = trying[:API_CONCURRENCY], trying[API_CONCURRENCY:]
        calls += len(trying)
        rejected += len(over)
        for x in over:
            ready_at[x] = t + RETRY_AFTER
        for x in accepted:           # 1초 뒤 끝난다
            running.remove(x)
            done += 1
        t += 1
    return t, calls, rejected


print(f"{'pool':>5} {'걸린 시간':>8} {'API 호출':>8} {'429':>6}")
for pool in [50, 20, 10, 5]:
    t, calls, rejected = run(pool)
    print(f"{pool:>5} {t:>7}초 {calls:>8} {rejected:>6}")
