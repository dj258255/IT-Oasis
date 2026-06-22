---
title: '쓰다가 전원이 꺼져도 — WAL과 크래시 복구'
titleEn: 'Surviving a Power Cut Mid-Write — WAL and Crash Recovery'
description: "데이터베이스의 마지막 정체성, 내구성과 원자성. 데이터 파일을 고치기 전에 로그에 먼저 적고 fsync 하면(write-ahead), 쓰다가 전원이 꺼져도 커밋된 건 살아남고 커밋 안 된 건 흔적 없이 사라진다. WAL과 크래시 복구를 C로 직접 만들고, 두 지점에 크래시를 주입해 증명한다."
descriptionEn: "The last identity of a database: durability and atomicity. By writing to a log before touching the data file (write-ahead) and fsync-ing, a crash mid-write leaves committed changes intact and uncommitted ones gone without a trace. We build the WAL and crash recovery in C and prove it by injecting crashes at two points."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - WAL
  - Crash Recovery
  - Devlog
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 8
---

지금까지 minidb는 저장하고([힙](/blog/project/minidb/minidb-heap-file)), 질의하고([실행기](/blog/project/minidb/minidb-executor)), 색인한다([B+Tree](/blog/project/minidb/minidb-btree)). 그런데 치명적인 구멍이 하나 있다. **데이터 파일에 쓰는 도중 전원이 꺼지면?** 페이지가 반만 써져 파일이 깨질 수 있다. 진짜 데이터베이스가 약속하는 건 그 반대다 — 커밋했으면 무슨 일이 있어도 살아남고(내구성), 커밋 안 했으면 흔적도 없다(원자성). ACID의 D와 A다. 그걸 주는 장치가 **WAL(Write-Ahead Log)** 이다.

## 핵심 규칙 — 데이터보다 로그를 먼저

WAL의 이름이 곧 규칙이다. **데이터 파일을 고치기 전에, 바뀔 내용을 로그에 먼저 적고 fsync 한다.** 트랜잭션 동안 바뀐 페이지는 메모리에 모아뒀다가(stage), 커밋할 때 이 순서로 흘러간다.

![WAL 흐름 — stage → 로그 기록 → 커밋 마커+fsync(내구성 분기점) → 데이터 적용 → 로그 비움. 두 크래시 지점](/uploads/project/minidb/wal-flow.svg)

1. 모은 페이지들을 **로그에** 쓴다.
2. **커밋 마커**를 쓰고 **fsync** 한다. ← 이 줄을 지나는 순간 트랜잭션은 "내구"하다.
3. 그제서야 **데이터 파일에** 실제로 적용한다.
4. 로그를 비운다(체크포인트).

왜 이 순서가 안전한가? 데이터 파일은 2번 이후에야 건드린다. 그러니 데이터 파일이 깨질 만한 순간엔 이미 로그에 완전한 기록이 있다.

## 복구 — 단 하나의 규칙

재시작할 때 로그를 보고 딱 하나만 판단한다.

- 로그에 **커밋 마커가 있으면** → 데이터에 다시 적용한다(**redo**). 커밋된 변경이라 반드시 반영돼야 한다.
- 커밋 마커가 **없으면** → 버린다. 커밋되지 않은 변경이라 없던 일이어야 한다.

이게 전부다. 이 한 규칙이 내구성과 원자성을 동시에 준다.

## 증명 — 두 지점에 크래시를 주입한다

말로는 쉽다. 진짜 되는지 보려면 크래시를 일으켜야 한다. 테스트에 크래시 주입 스위치를 두 개 만들어, 정확히 위험한 두 순간에 멈췄다.

- **커밋 마커 fsync 직후, 데이터 적용 전 크래시.** 데이터 파일엔 아직 옛값이 있다. 재시작 → 복구가 로그를 보고 커밋된 변경을 재적용 → 새 값이 살아난다. **내구성.**
- **페이지 로그만 쓰고 커밋 마커 전에 크래시.** 재시작 → 복구가 커밋 마커가 없음을 보고 버린다 → 데이터는 손도 안 탄 옛값 그대로. **원자성.**

![make test 결과 — WAL 테스트 6개 통과, 커밋 후 크래시 redo·커밋 전 크래시 discard 포함](/uploads/project/minidb/wal-test-output.svg)

`복구가 커밋된 변경을 재적용`, `커밋 안 된 변경은 흔적 없이 버려짐` 이 둘 다 통과한다. 전원이 꺼져도 데이터가 안 깨진다는 걸, 실제로 크래시를 일으켜 증명한 것이다.

## 정직한 한계

학습용이라 가장 단순한 형태다. 트랜잭션 하나씩(동시성 없음), 커밋 시점에 전부 force, 페이지 통째로 로깅(redo만). 진짜 DB는 여기에 동시성을 위한 **격리(ACID의 I)** — 락이나 MVCC — 를 얹고, 로그를 잘게(레코드 단위) 쓰고, undo까지 둔다. 버퍼 풀의 eviction 정책과의 완전한 통합(steal/no-force)도 더 정교하다. 하지만 핵심 뼈대 — write-ahead, 커밋 마커, redo 복구 — 는 진짜와 같다.

## 닫으며

이걸로 minidb는 데이터베이스의 큰 뼈대를 거의 다 갖췄다. 페이지에 저장하고(페이저·슬롯 페이지), 메모리에 캐시하고(버퍼 풀), 테이블로 묶고(힙), SQL을 받고(파서·실행기), 빠르게 찾고(B+Tree), 그리고 이제 전원이 꺼져도 안 깨진다(WAL). `SELECT`를 칠 때 그 아래 아홉 계층에서 무슨 일이 벌어지는지, 이제 전부 직접 만들어봤기에 안다. 새로운 걸 발명하진 않았지만, 진짜를 이해했다. 그게 이 프로젝트의 전부였다.
