# DE 공부 실습

블로그 "DE 공부" 시리즈의 실습 코드다. 글마다 폴더 하나이고(폴더 번호는 처음 쓸 때의 번호라 글 번호보다 하나 작다) 각 폴더의 README에 실행법과 기대 결과가 있다.

| 폴더 | 글 | 내용 |
|---|---|---|
| `ch01/` | [2편 데이터 파이프라인의 큰 그림](https://dj258255.github.io/IT-Oasis/blog/data/foundations/de-01-pipeline-big-picture/) | DuckDB로 Bronze, Silver, Gold 만들기 |
| `ch02/` | [3편 오케스트레이터는 무엇을 맡나](https://dj258255.github.io/IT-Oasis/blog/data/orchestration/de-02-what-orchestrator-does/) | `airflow standalone`으로 재시도와 메타DB 기록 보기 |
| `ch03/` | [4편 멱등성과 재시도·백오프](https://dj258255.github.io/IT-Oasis/blog/data/foundations/de-03-idempotency-retry-backoff/) | 파티션 덮어쓰기와 트랜잭션, 지터 비교 |
| `ch04/` | [5편 논리 날짜와 backfill](https://dj258255.github.io/IT-Oasis/blog/data/foundations/de-04-logical-date-backfill/) | 처리 날짜를 고르는 세 방법, catchup run 수 |
| `ch05/` | [6편 스케줄 트리거와 이벤트 트리거](https://dj258255.github.io/IT-Oasis/blog/data/orchestration/de-05-schedule-vs-event-trigger/) | 폴링 확인 횟수와 발견 지연 |
| `ch06/` | [7편 동시성 제한, 중복 실행, 사람 승인](https://dj258255.github.io/IT-Oasis/blog/data/orchestration/de-06-concurrency-dedup-approval/) | pool 크기별 429, 중복 이벤트와 run_id |
| `ch07/` | [8편 태스크 하나가 Pod 하나가 될 때](https://dj258255.github.io/IT-Oasis/blog/data/orchestration/de-07-task-per-pod-cost/) | Pod 기동 구간 찍기(클러스터 필요) |
| `ch08/` | [9편 지연은 백분위와 최댓값으로 본다](https://dj258255.github.io/IT-Oasis/blog/data/foundations/de-08-latency-percentiles/) | 평균과 꼬리, 백분위의 평균, 팬아웃 |
| `ch09/` | [10편 측정의 함정](https://dj258255.github.io/IT-Oasis/blog/data/foundations/de-09-measurement-pitfalls/) | coordinated omission, open/closed loop |
| `ch10/` | [11편 MQTT](https://dj258255.github.io/IT-Oasis/blog/data/streaming/de-10-mqtt-qos-session/) | Mosquitto로 와일드카드, retained, 세션, QoS(Docker 필요) |
| `ch11/` | [12편 Kafka 로그 구조](https://dj258255.github.io/IT-Oasis/blog/data/streaming/de-11-kafka-log-partition-group/) | Kafka와 같은 murmur2로 키 분배와 파티션 증설 |
| `ch12/` | [13편 프로듀서 설정과 지연](https://dj258255.github.io/IT-Oasis/blog/data/streaming/de-12-kafka-producer-latency/) | linger.ms와 배치 단순 모델 |
| `ch13/` | [14편 전달 보장](https://dj258255.github.io/IT-Oasis/blog/data/foundations/de-13-delivery-semantics/) | 처리와 커밋 순서, 트랜잭션 |
| `ch14/` | [15편 스키마 레지스트리와 호환성](https://dj258255.github.io/IT-Oasis/blog/data/foundations/de-14-schema-registry-compatibility/) | fastavro로 BACKWARD/FORWARD 확인 |
| `ch15/` | [16편 Flink의 시간과 watermark](https://dj258255.github.io/IT-Oasis/blog/data/streaming/de-15-flink-time-watermark/) | 허용치별 버림과 지연, 조용한 파티션 |
| `ch16/` | [17편 윈도와 interval join](https://dj258255.github.io/IT-Oasis/blog/data/streaming/de-16-flink-window-join/) | 조인 범위별 짝과 상태 |
| `ch17/` | [18편 체크포인트와 백프레셔](https://dj258255.github.io/IT-Oasis/blog/data/streaming/de-17-flink-checkpoint-backpressure/) | 간격별 가시성 지연과 재처리량 |
| `ch18/` | [19편 테이블 포맷](https://dj258255.github.io/IT-Oasis/blog/data/lakehouse/de-18-iceberg-table-format/), [20편 유지보수](https://dj258255.github.io/IT-Oasis/blog/data/lakehouse/de-19-iceberg-maintenance/) | PyIceberg로 스냅샷, 시간 여행, 만료 |
| `ch20/` | [21편 CDC로 레이크하우스 채우기](https://dj258255.github.io/IT-Oasis/blog/data/lakehouse/de-20-cdc-to-lakehouse/) | 조회 기반과 로그 기반 CDC |

## 공통 준비

```bash
python3 -m venv .venv
.venv/bin/pip install duckdb fastavro "pyiceberg[sql-sqlite,pyarrow]"   # ch01, 03, 04는 duckdb, ch14는 fastavro, ch18은 pyiceberg. 나머지는 표준 라이브러리만
```

ch02는 Airflow를 따로 설치한다(폴더 README 참고).
