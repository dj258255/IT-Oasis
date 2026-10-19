"""매일 00:00에 도는 일일 매출 태스크가 처리할 날짜를 세 가지 방법으로 정해 본다.

10/2 00:00에 트리거된 run이 실패하고, 10/3 09:00에 재시도된다고 친다.
Airflow 3.2 문서의 timetable 정의를 따라 각 방법이 받는 data_interval_start를 흉내 낸다.
"""
from datetime import datetime, timedelta

import duckdb

con = duckdb.connect()
con.sql("""
CREATE TABLE orders AS SELECT * FROM (VALUES
  (DATE '2026-10-01', 30000), (DATE '2026-10-01', 12000),
  (DATE '2026-10-02',  8000)) t(day, amount)       -- 10/2는 아직 들어오는 중이라 일부만 있다
""")


def daily_sales(day):
    return con.execute("SELECT coalesce(sum(amount), 0) FROM orders WHERE day = ?", [day]).fetchone()[0]


trigger_at = datetime(2026, 10, 2, 0, 0)     # 이 run이 트리거된 시각(run_after)

ways = {
    # 실행하는 순간의 시계로 "어제"를 계산한다
    "now() - 1일": lambda now: (now - timedelta(days=1)).date(),
    # 3.x 기본 CronTriggerTimetable: data interval이 없어 start = end = 트리거 시각
    "CronTrigger의 data_interval_start": lambda now: trigger_at.date(),
    # CronDataIntervalTimetable 또는 CronTriggerTimetable(interval=1일): 구간이 트리거 시각에 끝난다
    "1일 구간의 data_interval_start": lambda now: (trigger_at - timedelta(days=1)).date(),
}

for label, at in [("첫 실행 10/2 00:00", trigger_at), ("재시도 10/3 09:00", datetime(2026, 10, 3, 9, 0))]:
    print(f"[{label}]")
    for name, pick in ways.items():
        day = pick(at)
        print(f"  {name:<34} → {day} {daily_sales(day):>6}원")
