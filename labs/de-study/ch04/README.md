# Ch-04 실습: 처리 날짜를 고르는 방법과 catchup 수

```bash
python interval_vs_now.py     # duckdb 필요
python catchup_count.py
```

## interval_vs_now.py

10/1 주문 42,000원, 아직 들어오는 중인 10/2 주문 8,000원. 매일 00시 run이 10/2 00:00에 실행되다 실패하고 10/3 09:00에 재시도된다. 각 방법이 받는 `data_interval_start`는 Airflow 3.2 문서의 timetable 정의를 흉내 냈다(Airflow를 띄운 결과가 아니다).

| 방법 | 첫 실행 | 재시도 |
|---|---|---|
| `now() - 1일` | 10/1, 42,000원 | 10/2, 8,000원 |
| 3.x 기본 CronTrigger의 `data_interval_start` | 10/2, 8,000원 | 10/2, 8,000원 |
| 1일 구간의 `data_interval_start` | 10/1, 42,000원 | 10/1, 42,000원 |

## catchup_count.py

start_date 2026-01-01, 2026-10-19 14:00에 켰을 때 catchup=True가 만드는 run 수.

| timetable | run 수 |
|---|---|
| CronDataInterval | 291개(01/01 ~ 10/18) |
| CronTrigger | 292개(01/01 ~ 10/19) |
