"""매일 00:00 스케줄 DAG를 늦게 켰을 때 catchup=True가 한꺼번에 만드는 run 수를 센다.

start_date 2026-01-01, DAG를 켠 시각 2026-10-19 14:00.
- CronDataIntervalTimetable: 구간 [d, d+1일)이 끝난 것마다 run 하나(logical date = d)
- CronTriggerTimetable: 트리거 시각 d 00:00이 지난 것마다 run 하나(logical date = d)
"""
from datetime import datetime, timedelta

start = datetime(2026, 1, 1)
enabled_at = datetime(2026, 10, 19, 14, 0)
day = timedelta(days=1)

interval_runs = []
d = start
while d + day <= enabled_at:
    interval_runs.append(d)
    d += day

trigger_runs = []
d = start
while d <= enabled_at:
    trigger_runs.append(d)
    d += day

print(f"CronDataInterval: {len(interval_runs)}개 run, logical date {interval_runs[0]:%m/%d} ~ {interval_runs[-1]:%m/%d}")
print(f"CronTrigger:      {len(trigger_runs)}개 run, logical date {trigger_runs[0]:%m/%d} ~ {trigger_runs[-1]:%m/%d}")
