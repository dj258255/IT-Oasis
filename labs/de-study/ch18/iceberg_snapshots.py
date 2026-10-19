"""PyIceberg로 로컬 Iceberg 테이블을 만들고 커밋마다 생기는 메타데이터와 스냅샷, 시간 여행, 스냅샷 만료를 본다.

카탈로그는 SQLite 파일, 데이터는 ./warehouse 폴더에 쓴다. 실행할 때마다 처음부터 다시 만든다.
필요: pip install "pyiceberg[sql-sqlite,pyarrow]"
"""
import os
import shutil
import time
from pathlib import Path

import pyarrow as pa
from pyiceberg.catalog.sql import SqlCatalog

HERE = Path(__file__).resolve().parent
WH = HERE / "warehouse"
shutil.rmtree(WH, ignore_errors=True)
WH.mkdir()

catalog = SqlCatalog("local", uri=f"sqlite:///{WH}/catalog.db", warehouse=f"file://{WH}")
catalog.create_namespace("shop")


def orders(rows):
    return pa.table({"order_id": pa.array([r[0] for r in rows], pa.int64()),
                     "day": pa.array([r[1] for r in rows], pa.string()),
                     "amount": pa.array([r[2] for r in rows], pa.int64())})


table = catalog.create_table("shop.orders", schema=orders([(0, "", 0)]).schema)


def files(kind):
    return sorted(p.name for p in WH.rglob("*") if p.is_file() and kind(p.name))


def report(label):
    table.refresh()
    snap = table.current_snapshot()
    meta = files(lambda n: n.endswith(".metadata.json"))
    manifests = files(lambda n: n.endswith(".avro"))
    data = files(lambda n: n.endswith(".parquet"))
    rows = table.scan().to_arrow().num_rows
    print(f"{label:<26} snapshot={snap.snapshot_id if snap else None} op={snap.summary.operation.value if snap else '-':<9} "
          f"행 {rows:>2}  metadata.json {len(meta)}  manifest/list {len(manifests)}  parquet {len(data)}")


report("테이블 생성")
table.append(orders([(1, "10-01", 30000), (2, "10-01", 12000)]));  report("append 10/1 주문 2건")
table.append(orders([(3, "10-02", 8000)]));                         report("append 10/2 주문 1건")
table.append(orders([(4, "10-02", 5000)]));                         report("append 10/2 주문 1건 더")
table.overwrite(orders([(1, "10-01", 30000), (2, "10-01", 12000), (3, "10-02", 8000), (4, "10-02", 5500)]))
report("overwrite(4번 금액 정정)")

print("\n[스냅샷 이력]")
snaps = table.snapshots()
for s in snaps:
    print(f"  {s.snapshot_id} parent={s.parent_snapshot_id} op={s.summary.operation.value} "
          f"added-records={s.summary.get('added-records')} deleted-records={s.summary.get('deleted-records')}")

print("\n[시간 여행]")
for s in snaps:
    t = table.scan(snapshot_id=s.snapshot_id).to_arrow()
    total = sum(t.column("amount").to_pylist())
    print(f"  snapshot {s.snapshot_id}: 행 {t.num_rows}, 매출 합계 {total:,}원")

print("\n[스냅샷 만료] 현재 스냅샷만 남기고 나머지를 만료한다")
before = len(files(lambda n: n.endswith(".parquet")))
old = [s.snapshot_id for s in snaps if s.snapshot_id != table.current_snapshot().snapshot_id]
table.maintenance.expire_snapshots().by_ids(old).commit()
table.refresh()
print(f"  남은 스냅샷 {len(table.snapshots())}개, parquet 파일 {before}개 → {len(files(lambda n: n.endswith('.parquet')))}개")
try:
    table.scan(snapshot_id=old[0]).to_arrow()
    print("  만료된 스냅샷으로 시간 여행: 성공")
except Exception as e:
    print(f"  만료된 스냅샷으로 시간 여행: 실패 ({type(e).__name__})")
