# DE 공부 21편 실습: 조회 기반 CDC와 로그 기반 CDC

```bash
python cdc_poll_vs_log.py
```

SQLite 테이블에 주문 변경을 일으키고, 트리거로 모든 변경을 변경 로그 테이블에 남긴다(로그 기반 흉내). 조회 기반은 10초마다 `updated_at > 마지막 조회 시각`을 가져간다.

| 방식 | 받은 것 |
|---|---|
| 조회 기반 | 10초: id=1 shipped / 30초: id=3 pending |
| 로그 기반 | id=1 생성, paid, shipped / id=2 생성, 삭제 / id=3 생성, 삭제 |

조회 기반은 중간 상태(pending, paid), 조회 사이에 생겼다 지워진 행(id=2), 삭제(id=3)를 놓친다.
