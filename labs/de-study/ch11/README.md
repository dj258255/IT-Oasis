# DE 공부 12편 실습: 키와 파티션

```bash
python murmur2.py       # Kafka 단위 테스트(UtilsTest.testMurmur2)의 값과 같은지 확인
python partitions.py
```

`murmur2.py`는 Kafka 기본 파티셔너의 해시(`Utils.murmur2`, `BuiltInPartitioner.partitionForKey`)를 옮겼다. Kafka 저장소 테스트 값 6개와 일치한다.

`partitions.py` 결과(키 `user-0` ~ `user-9999`)

| 확인 | 결과 |
|---|---|
| 파티션 6개에 나뉜 키 수 | 1700, 1668, 1703, 1575, 1650, 1704 |
| 6개 → 8개로 늘렸을 때 파티션이 바뀐 키 | 7,462개(74.6%) |
| 6개 → 12개로 늘렸을 때 파티션이 바뀐 키 | 5,039개(50.4%) |
| 파티션 6개에 컨슈머 8개 | 2개는 할당받을 파티션이 없다 |
