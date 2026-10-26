# DE 공부 19, 20편 실습: PyIceberg로 스냅샷과 시간 여행, 만료

```bash
pip install "pyiceberg[sql-sqlite,pyarrow]"
python iceberg_snapshots.py      # ./warehouse에 SQLite 카탈로그와 테이블을 새로 만든다
```

PyIceberg 0.12.0에서 확인한 결과(스냅샷 ID는 실행마다 다르다).

| 작업 | 행 | metadata.json | manifest/list | parquet |
|---|---|---|---|---|
| 생성 | 0 | 1 | 0 | 0 |
| append 2건 | 2 | 2 | 2 | 1 |
| append 1건 | 3 | 3 | 4 | 2 |
| append 1건 | 4 | 4 | 6 | 3 |
| overwrite | 4 | 5 | 10 | 4 |

- overwrite는 delete 스냅샷과 append 스냅샷을 한 커밋으로 만든다. delete 스냅샷으로 시간 여행하면 행이 0개다.
- 스냅샷별 매출 합계: 42,000 / 50,000 / 55,000 / 0 / 55,500원
- 현재 스냅샷만 남기고 만료: 스냅샷 5 → 1개, 만료된 스냅샷으로 시간 여행 실패, parquet 파일은 4개 그대로
