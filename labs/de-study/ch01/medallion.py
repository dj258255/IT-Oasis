import json
import random
import sys

import duckdb

random.seed(1)
DEDUP = "--no-dedup" not in sys.argv

# 원천: 사용자 5명의 상품 페이지 조회 로그 1만 건. 중복, 잘못된 값, 순서 뒤바뀜을 섞는다
rows = []
for i in range(10_000):
    r = {"user": f"u{i % 5}", "ts": 1_700_000_000 + i * 0.1, "price": round(random.gauss(30000, 5000))}
    if i % 500 == 0:
        r["price"] = "ERR"           # 잘못된 값
    rows.append(r)
    if i % 300 == 0:
        rows.append(dict(r))        # 같은 이벤트가 두 번 들어옴
rows[100:300] = random.sample(rows[100:300], 200)   # 늦게 도착한 이벤트

with open("bronze.jsonl", "w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")

con = duckdb.connect()

# Bronze: 받은 그대로 둔다
con.sql("""
CREATE TABLE bronze AS
SELECT * FROM read_json('bronze.jsonl',
  columns = {'user': 'VARCHAR', 'ts': 'DOUBLE', 'price': 'VARCHAR'})
""")

# Silver: 중복 제거, 타입 정리, 잘못된 값 걸러내기
con.sql(f"""
CREATE TABLE silver AS
SELECT {'DISTINCT' if DEDUP else ''} "user", to_timestamp(ts) AS ts, CAST(price AS BIGINT) AS price
FROM bronze
WHERE TRY_CAST(price AS BIGINT) IS NOT NULL
""")

# Gold: 사용자별 1분간 본 상품 평균 가격
con.sql("""
CREATE TABLE gold AS
SELECT "user", time_bucket(INTERVAL '1 minute', ts) AS minute,
       round(avg(price)) AS avg_price, count(*) AS views
FROM silver GROUP BY ALL ORDER BY ALL
""")

for t in ["bronze", "silver", "gold"]:
    print(f"{t:<7}", con.sql(f"SELECT count(*) FROM {t}").fetchone()[0], "행")
print("gold 조회 수 합계", con.sql("SELECT sum(views) FROM gold").fetchone()[0])
print(con.sql("SELECT * FROM gold LIMIT 3"))
