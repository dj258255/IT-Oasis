# Ch-14 실습: Avro 스키마 해석

```bash
pip install fastavro
python avro_compat.py
```

v1(`order_id: long`, `amount: int`)에서 바꾼 스키마로 실제로 쓰고 읽는다(fastavro 1.13.1).

| 변경 | BACKWARD(새 reader, 옛 데이터) | FORWARD(옛 reader, 새 데이터) |
|---|---|---|
| 필드 추가, 기본값 있음 | 읽힘 | 읽힘 |
| 필드 추가, 기본값 없음 | 실패 | 읽힘 |
| 필드 삭제 | 읽힘 | 실패 |
| int → long | 읽힘 | 실패 |
| int → string | 실패 | 실패 |
