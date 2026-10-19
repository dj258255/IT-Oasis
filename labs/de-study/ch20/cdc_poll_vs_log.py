"""updated_at을 주기적으로 조회하는 CDC와 변경 로그를 읽는 CDC가 잡는 변경을 비교한다.

SQLite 테이블 하나에 주문 변경을 일으키고, 트리거로 모든 변경을 변경 로그 테이블에 남긴다(로그 기반 CDC 흉내).
조회 기반 CDC는 10초마다 updated_at > 마지막 조회 시각인 행을 가져간다.
"""
import sqlite3

db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT, updated_at REAL);
CREATE TABLE changelog(seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, id INTEGER, status TEXT, at REAL);
CREATE TRIGGER ins AFTER INSERT ON orders BEGIN INSERT INTO changelog(op,id,status,at) VALUES('c',NEW.id,NEW.status,NEW.updated_at); END;
CREATE TRIGGER upd AFTER UPDATE ON orders BEGIN INSERT INTO changelog(op,id,status,at) VALUES('u',NEW.id,NEW.status,NEW.updated_at); END;
CREATE TRIGGER del AFTER DELETE ON orders BEGIN INSERT INTO changelog(op,id,status,at) VALUES('d',OLD.id,OLD.status,NULL); END;
""")

# (시각, SQL, 인자)
changes = [
    (1, "INSERT INTO orders VALUES(1,'pending',?)", [1]),
    (3, "UPDATE orders SET status='paid', updated_at=? WHERE id=1", [3]),
    (5, "UPDATE orders SET status='shipped', updated_at=? WHERE id=1", [5]),     # 한 조회 주기 안에서 상태가 두 번 바뀐다
    (12, "INSERT INTO orders VALUES(2,'pending',?)", [12]),
    (15, "DELETE FROM orders WHERE id=2", []),                                    # 다음 조회 전에 지워진다
    (22, "INSERT INTO orders VALUES(3,'pending',?)", [22]),
    (31, "DELETE FROM orders WHERE id=3", []),                                    # 조회로 한 번 본 뒤 지워진다
]

polled, last_poll, i = [], 0, 0
for now in range(0, 41):
    while i < len(changes) and changes[i][0] == now:
        db.execute(changes[i][1], changes[i][2])
        i += 1
    if now % 10 == 0 and now > 0:
        rows = db.execute("SELECT id, status, updated_at FROM orders WHERE updated_at > ? ORDER BY id", [last_poll]).fetchall()
        polled += [f"{now}초 조회: id={r[0]} {r[1]}" for r in rows]
        last_poll = now

print("[조회 기반]")
for p in polled:
    print(" ", p)
print("[로그 기반]")
for op, rid, status, at in db.execute("SELECT op, id, status, at FROM changelog ORDER BY seq"):
    print(f"  {op} id={rid} {status}")
print("현재 테이블:", db.execute("SELECT * FROM orders").fetchall())
