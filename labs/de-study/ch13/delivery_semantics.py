"""컨슈머가 메시지 10개를 처리하다 7번째 처리 직후 죽을 때, 커밋 방식에 따라 결과가 어떻게 남는지 본다.

다시 시작한 컨슈머는 마지막으로 커밋된 오프셋부터 읽는다.
"""
MESSAGES = list(range(1, 11))
CRASH_AFTER = 7            # 7번 메시지 처리 직후(다음 커밋 전) 죽는다
COMMIT_EVERY = 5           # 처리 후 커밋 방식은 5개마다 커밋한다


def at_most_once():
    """커밋 먼저, 처리 나중. 커밋한 뒤 처리 전에 죽으면 그 메시지는 영영 처리되지 않는다."""
    out, committed = [], 0
    for m in MESSAGES:
        committed = m                      # 먼저 커밋
        if m == CRASH_AFTER:
            break                          # 처리 전에 죽음
        out.append(m)
    for m in MESSAGES[committed:]:         # 재시작: 커밋 다음부터
        out.append(m)
    return out


def at_least_once():
    """처리 먼저, 커밋 나중(5개마다). 처리했지만 커밋 못 한 메시지는 다시 처리된다."""
    out, committed = [], 0
    for m in MESSAGES:
        out.append(m)                      # 처리
        if m % COMMIT_EVERY == 0:
            committed = m                  # 커밋
        if m == CRASH_AFTER:
            break                          # 커밋 전에 죽음
    for m in MESSAGES[committed:]:
        out.append(m)
    return out


def transactional():
    """출력과 오프셋을 한 트랜잭션으로 커밋한다(5개 단위). 죽으면 커밋 안 된 출력은 abort되어 read_committed 독자에게 안 보인다."""
    visible, committed, pending = [], 0, []
    for m in MESSAGES:
        pending.append(m)
        if m == CRASH_AFTER:
            pending = []                   # 트랜잭션 abort: 6, 7 출력은 보이지 않는다
            break
        if m % COMMIT_EVERY == 0:
            visible += pending             # 출력과 오프셋을 함께 커밋
            committed, pending = m, []
    for m in MESSAGES[committed:]:
        pending.append(m)
        if m % COMMIT_EVERY == 0 or m == MESSAGES[-1]:
            visible += pending
            pending = []
    return visible


for name, f in [("at-most-once(커밋 후 처리)", at_most_once),
                ("at-least-once(처리 후 커밋)", at_least_once),
                ("트랜잭션(출력+오프셋 함께)", transactional)]:
    out = f()
    missing = sorted(set(MESSAGES) - set(out))
    dup = sorted({m for m in out if out.count(m) > 1})
    print(f"{name:<28} 결과 {out}  빠짐 {missing}  중복 {dup}")
