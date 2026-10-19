"""Avro의 writer 스키마와 reader 스키마가 다를 때 읽히는지 fastavro로 직접 확인한다.

BACKWARD 호환: 새 스키마(reader)로 옛 데이터(writer)를 읽을 수 있다 → 컨슈머를 먼저 올릴 수 있다
FORWARD 호환:  옛 스키마(reader)로 새 데이터(writer)를 읽을 수 있다 → 프로듀서를 먼저 올릴 수 있다
"""
import io

from fastavro import parse_schema, schemaless_reader, schemaless_writer


def schema(*fields):
    return {"type": "record", "name": "Order", "fields": list(fields)}


V1 = schema({"name": "order_id", "type": "long"}, {"name": "amount", "type": "int"})
CHANGES = {
    "필드 추가(기본값 있음)": schema({"name": "order_id", "type": "long"}, {"name": "amount", "type": "int"},
                                {"name": "coupon", "type": ["null", "string"], "default": None}),
    "필드 추가(기본값 없음)": schema({"name": "order_id", "type": "long"}, {"name": "amount", "type": "int"},
                                {"name": "coupon", "type": "string"}),
    "필드 삭제(amount)": schema({"name": "order_id", "type": "long"}),
    "타입 넓히기(int→long)": schema({"name": "order_id", "type": "long"}, {"name": "amount", "type": "long"}),
    "타입 바꾸기(int→string)": schema({"name": "order_id", "type": "long"}, {"name": "amount", "type": "string"}),
}


def sample_for(s):
    rec = {}
    for f in s["fields"]:
        rec[f["name"]] = {"order_id": 1001, "amount": 30000, "coupon": "WELCOME"}[f["name"]]
        if f["type"] == "string" and f["name"] == "amount":
            rec["amount"] = "30000"
    return rec


def can_read(writer, reader):
    buf = io.BytesIO()
    schemaless_writer(buf, parse_schema(writer), sample_for(writer))
    buf.seek(0)
    try:
        rec = schemaless_reader(buf, parse_schema(writer), parse_schema(reader))
        return f"읽힘 {rec}"
    except Exception as e:  # 스키마 해석 실패
        return f"실패 ({type(e).__name__})"


for name, v2 in CHANGES.items():
    print(f"[{name}]")
    print(f"  BACKWARD: v2로 v1 데이터 읽기 → {can_read(V1, v2)}")
    print(f"  FORWARD:  v1으로 v2 데이터 읽기 → {can_read(v2, V1)}")
