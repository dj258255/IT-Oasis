---
title: '보조 인덱스: PK가 몰래 기대던 가정들을 갚기'
titleEn: 'Secondary Indexes: Paying Back the Assumptions the PK Quietly Leaned On'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈. 3편의 B+Tree 인덱스는 첫 컬럼(PK)에만 걸렸다. 진짜 DB처럼 아무 컬럼에나 CREATE INDEX를 걸려면 네 단계가 필요했다 - 비유니크 키를 받는 B+Tree(중복이 분할로 흩어지는 문제와 하한 탐색), 기존 행으로 인덱스를 짓고 카탈로그에 영속화, INSERT/UPDATE가 인덱스를 함께 갱신하고 트랜잭션 롤백 시 되돌리는 WAL, 그리고 플래너가 그 인덱스를 골라 find_all + heap_get + WHERE 재검사로 거르는 인덱스 스캔. PK 인덱스가 유니크라서 조용히 기대던 가정들을 하나씩 갚는 과정이다."
descriptionEn: "Part 10 of building a relational database from scratch in C. The part-3 B+Tree only indexed the first column (PK). To CREATE INDEX on any column like a real DB took four stages: a B+Tree that accepts duplicate keys (and the lower-bound search needed because duplicates scatter across leaves on split), building the index from existing rows and persisting it in the catalog, INSERT/UPDATE maintaining it with transaction rollback via WAL, and the planner picking it for an index scan with find_all + heap_get + WHERE recheck. It's all about paying back the assumptions the unique PK index quietly relied on."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - B-Tree
  - Index
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 10
---

[3편](/blog/project/minidb/minidb-3-index-wal)에서 B+Tree 인덱스를 만들었지만, 그건 **첫 컬럼(PK)에만** 걸렸다.
`WHERE id = 5`는 인덱스를 타도, `WHERE age = 20`은 풀 스캔이었다.
진짜 DB는 `CREATE INDEX`로 아무 컬럼에나 인덱스를 건다.
그걸 붙이는 데 네 단계가 걸렸는데, 단계가 많았던 이유가 흥미롭다.
**PK 인덱스가 "유니크하다"는 사실에 기대 조용히 넘어가던 가정들이, 보조 인덱스에선 하나씩 깨졌기 때문이다.**

## 1. 같은 값이 여럿이다 - 중복 키 B+Tree

PK는 유일하다.
그래서 3편의 B+Tree는 "키 하나에 값 하나"였고, `btree_insert`는 같은 키가 들어오면 **덮어썼다**.
PK에선 같은 키가 두 번 올 일이 없으니 이 덮어쓰기가 문제될 일도 없었다.

그런데 `age` 같은 보조 인덱스 컬럼은 다르다.
나이 20인 사람이 셋이면, 키 20에 RID가 셋 달려야 한다.
덮어쓰면 둘이 사라진다.
그래서 덮어쓰지 않고 같은 키도 새 항목으로 추가하는 `btree_insert_dup`을 만들었다.

문제는 **읽기**였다.
키 20인 항목을 다 찾으려는데, 중복은 리프 분할 때문에 **여러 리프에 흩어진다.**
20이 잔뜩 쌓여 리프가 쪼개지면, 분할의 경계 키(분리키)가 하필 20이 된다.
그러면 20짜리 항목이 왼쪽 리프에도, 오른쪽 리프에도 걸친다.
3편의 검색은 분리키와 같으면 오른쪽으로 갔는데(`>=`), 그러면 왼쪽에 흩어진 20들을 놓친다.

그래서 **하한 탐색(lower bound)** 이 필요했다.
분리키와 같으면 오른쪽으로 넘어가지 않고(`>`, `>=` 아님) 왼쪽 자식으로 내려가, 20이 시작될 수 있는 가장 왼쪽 리프에 닿는다.
거기서부터 리프 체인을 오른쪽으로 훑으며 20을 다 모으고, 21을 만나면 멈춘다.
검증으로 같은 키 50개를 주변 키와 섞어 일부러 여러 리프로 쪼갠 뒤, `find_all`이 50개를 전부 찾는지 확인했다.

> 더 깊이: 인덱스가 데이터를 어떻게 정렬·탐색하는지, 클러스터형 인덱스와 보조 인덱스가 행을 가리키는 방식이 어떻게 다른지는 [DB 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms).

## 2. 한 번 짓고, 살아남기 - CREATE INDEX와 카탈로그

`CREATE INDEX age_idx ON t(age)`를 받으면, 그 시점에 **이미 들어 있는 행들**로 인덱스를 채워야 한다.
힙을 한 번 훑으며 각 행의 `age` 값과 RID를 `btree_insert_dup`으로 등록한다.

그다음이 중요하다 - **인덱스는 재시작해도 살아남아야 한다.**
테이블 스키마가 카탈로그에 저장되듯, "이 테이블엔 age_idx라는 인덱스가 age 컬럼에 있다"도 카탈로그에 적어야, 다시 열 때 그 인덱스 파일을 도로 연다.
[2편](/blog/project/minidb/minidb-2-sql-engine)에서 카탈로그가 스키마 구조체를 통째로 파일에 직렬화한다고 했는데, 거기에 인덱스 정의(이름 + 컬럼)를 덧붙이는 것으로 영속화가 끝났다.
인덱스는 자기 파일(`<db>.<테이블>.<인덱스명>.idx`)을 따로 쓴다 - 힙·PK 인덱스와 똑같이 파일 단위로 분리해 두니, 코드를 거의 안 고치고 인덱스를 하나 더 얹을 수 있었다.

여기까지면 인덱스는 만들어지고 재오픈에도 살아남지만, 아직 **박제** 상태다.
만든 순간의 행만 담겨 있고, 이후 INSERT는 인덱스를 모른다.

## 3. 계속 맞아야 한다 - DML 유지보수와 WAL

INSERT는 쉽다.
새 행을 넣을 때 PK 인덱스에 등록하던 자리에서, 보조 인덱스에도 `(컬럼값 -> RID)`를 등록하면 된다.

UPDATE에서 한 번 데었다.
minidb의 UPDATE는 가변 길이라 제자리 수정이 안 돼서, **옛 행을 지우고(tombstone) 새 행을 삽입**한다 - 즉 RID가 바뀐다.
처음엔 "바뀐 컬럼의 인덱스만 갱신하면 되겠지" 했는데, 아니었다.
RID가 통째로 바뀌니, **인덱싱한 컬럼이 안 바뀌었어도** 그 인덱스가 옛 RID(이제 tombstone)를 가리키게 된다.
그러면 그 행이 검색에서 사라진다.
그래서 UPDATE는 바뀐 컬럼과 무관하게 **모든 보조 인덱스에 새 RID를 다시 등록**해야 했다.

DELETE는 반대로, 아무것도 안 해도 됐다.
삭제는 힙 행을 tombstone 처리할 뿐, 인덱스 항목은 그냥 둔다.
나중에 그 stale 항목을 따라가도 `heap_get`이 tombstone을 만나 거른다(4단계에서 본다).
B+Tree 삭제를 안 만들어도 되는 이유다 - PK 인덱스가 줄곧 그래 왔던 것과 같다.

마지막으로 **WAL**.
[3편·4편](/blog/project/minidb/minidb-4-transactions)에서 데이터와 PK 인덱스를 WAL로 묶어 트랜잭션이 원자적으로 커밋·롤백되게 했는데, 보조 인덱스도 자기 WAL로 똑같이 묶었다.
그래서 트랜잭션 안에서 INSERT한 인덱스 항목이, `ROLLBACK`하면 인덱스에서도 함께 사라진다.
begin/commit/rollback과 autocommit 경로의 다섯 군데에, 데이터·PK 인덱스를 다루던 코드 옆에 보조 인덱스 루프를 나란히 더하는 일이었다.

## 4. 드디어 빨라진다 - 플래너와 재검사

이제 쿼리가 실제로 인덱스를 쓰게 한다.
`WHERE age = 20`처럼 보조 인덱스 컬럼에 `=` 조건이 걸리면, 플래너가 그 인덱스를 골라 `find_all(20)`로 후보 RID들을 모은다.

그런데 여기서 PK 점 조회와 결정적으로 다른 한 가지 - **재검사(recheck)** 가 필요하다.
보조 인덱스가 준 RID를 곧이곧대로 믿으면 안 된다.
이유가 셋이다.
첫째, 삭제된 행의 stale 항목이 RID를 주는데 그 RID는 tombstone이다 -> `heap_get`이 실패해 걸러진다.
둘째, UPDATE로 값이 바뀌어 남은 옛 항목이 있을 수 있다.
셋째, 삭제로 빈 슬롯을 새 행이 재사용하면, 옛 RID가 엉뚱한 행을 가리킬 수 있다.
그래서 후보 RID마다 `heap_get`으로 행을 읽고, **WHERE를 다시 평가**해 진짜 맞는 행만 내보낸다.

이게 실제 DB가 하는 "**index scan + recheck**"와 같은 패턴이다.
인덱스는 "후보를 좁혀주는" 역할이고, 최종 판정은 실제 행으로 한 번 더 한다.
덕분에 B+Tree에 삭제 기능이 없어도, stale 항목이 남아 있어도 결과는 정확하다.

그리고 [8편의 EXPLAIN](/blog/project/minidb/minidb-8-explain)에 이걸 드러냈다.

```
EXPLAIN SELECT * FROM t WHERE age = 20;
Index Scan using age_idx on t  (age = 20, recheck)
```

EXPLAIN과 실행기가 "어떤 인덱스를 쓸지" 판단하는 함수(`sec_index_for`)를 **공유**하게 해서, 8편에서 세운 원칙 - 플랜이 실제 실행과 절대 안 어긋난다 - 을 여기서도 지켰다.

> 더 깊이: 옵티마이저가 인덱스 스캔과 풀 스캔 중 무엇을 고르는지, 인덱스만으로 끝내는 커버링 인덱스는 무엇인지는 [DB 인덱스 ②: 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types)과 [③ Covering Index](/blog/theory/db-index-03-covering-index-ios).

## 정직한 한계

- **INT 컬럼만.** B+Tree 키가 int64라, TEXT 컬럼 인덱스는 문자열 키 B+Tree가 필요해 아직 못 한다.
- **`=` 조건만.** 보조 인덱스로 범위(`age > 20`)는 아직 안 탄다(PK는 됨). find_all을 범위 버전으로 확장하면 되는 다음 숙제다.
- **NULL은 색인 안 함.** NULL은 B+Tree 키가 될 수 없어 인덱스에서 빠진다(실제 DB도 보통 NULL을 따로 다룬다).
- 비용 모델이 없어, 인덱스가 항상 이득이라 가정하고 쓴다(전체의 90%가 걸리는 조건이면 풀 스캔이 더 빠른데, 그 판단은 [DB 인덱스 ②](/blog/theory/db-index-02-scan-types)의 영역).

## 닫으며

보조 인덱스를 만들며 계속 마주친 건, **PK 인덱스가 유니크라서 그냥 넘어가던 것들**이었다.
키가 안 겹친다는 가정, 한 키에 RID 하나라는 가정, 삭제·갱신해도 인덱스가 알아서 맞다는 착각.
보조 인덱스는 그 가정들을 하나씩 깨고 - 중복을 담고, 흩어진 걸 다 찾고, 갱신 때 따라 고치고, 믿지 말고 재검사하고 - 그렇게 갚아 나가는 과정이었다.
같은 B+Tree인데, 유일성이라는 특권을 내려놓으니 할 일이 이렇게 많아진다는 걸 손으로 배웠다.

> **시리즈**: [1. 저장 계층](/blog/project/minidb/minidb-1-storage) · [2. SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/minidb/minidb-3-index-wal) · [4. 트랜잭션](/blog/project/minidb/minidb-4-transactions) · [5. 조인과 집계](/blog/project/minidb/minidb-5-join-aggregate) · [6. BETWEEN과 LIKE](/blog/project/minidb/minidb-6-between-like) · [7. 직접 재보기](/blog/project/minidb/minidb-7-benchmark) · [8. EXPLAIN](/blog/project/minidb/minidb-8-explain) · [9. NULL 저장](/blog/project/minidb/minidb-9-null-storage) · 10. 보조 인덱스 · [코드(GitHub)](https://github.com/dj258255/minidb)
