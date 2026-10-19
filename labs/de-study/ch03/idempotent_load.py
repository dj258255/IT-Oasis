from datetime import date

import duckdb

con = duckdb.connect()
con.sql("""
CREATE TABLE orders AS SELECT * FROM (VALUES
  (1, DATE '2026-10-01', 30000),
  (2, DATE '2026-10-01', 12000),
  (3, DATE '2026-10-02',  8000)) t(order_id, day, amount)
""")

DAY = date(2026, 10, 1)
INSERT_SQL = "INSERT INTO daily_sales SELECT day, sum(amount) FROM orders WHERE day = ? GROUP BY day"


def fresh():
    con.sql("CREATE OR REPLACE TABLE daily_sales (day DATE, total BIGINT)")


def show(label):
    print(f"{label:<28}", con.sql("SELECT * FROM daily_sales ORDER BY day").fetchall())


def overwrite(day, crash=False, tx=True):
    """그 날짜 파티션을 지우고 다시 넣는다. crash=True면 지운 직후 죽는다."""
    if tx:
        con.execute("BEGIN")
    try:
        con.execute("DELETE FROM daily_sales WHERE day = ?", [day])
        if crash:
            raise RuntimeError("지우고 넣기 전에 죽음")
        con.execute(INSERT_SQL, [day])
        if tx:
            con.execute("COMMIT")
    except RuntimeError:
        if tx:
            con.execute("ROLLBACK")


# 1) append: 같은 날짜를 두 번 돌린다
fresh()
for _ in range(2):
    con.execute(INSERT_SQL, [DAY])
show("append 두 번")

# 2) 파티션 덮어쓰기: 두 번 돌려도 같은가
fresh()
for _ in range(2):
    overwrite(DAY)
show("덮어쓰기 두 번")

# 3) 덮어쓰기 도중에 죽으면: 트랜잭션 없이
overwrite(DAY, crash=True, tx=False)
show("트랜잭션 없이 도중에 죽음")

# 4) 덮어쓰기 도중에 죽으면: 트랜잭션 안에서
fresh()
overwrite(DAY)
overwrite(DAY, crash=True, tx=True)
show("트랜잭션 안에서 도중에 죽음")
