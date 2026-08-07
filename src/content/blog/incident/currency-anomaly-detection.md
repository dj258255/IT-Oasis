---
title: '셀 수 없으면 롤백 말고는 선택지가 없다, 게임 재화 이상 탐지'
titleEn: "If You Cannot Count It, Rollback Is Your Only Option: Detecting Duplicated Game Currency"
description: "2014년 리니지는 아데나 복사에 서버를 6일 전으로 되돌렸고, 2022년 로스트아크는 같은 성격의 골드 복사에 전면 롤백 대신 선별 회수를 택했습니다. 그 차이는 셀 수 있느냐에서 갈립니다. 재화 원장 2,000만 행에서 조사 쿼리 세 가지를 정답지와 대조하고, 통계적 이상 탐지가 정상 헤비 이용자 40명을 함께 지목하는 것을 실측했습니다."
descriptionEn: "In 2014 NCSoft rolled an entire Lineage server back six days after an adena duplication bug. In December 2022 Smilegate faced a structurally identical gold duplication bug in Lost Ark and chose selective clawback instead: they blocked the item in 17 minutes, shipped a fix in four hours, and traced the circulation of the duplicated currency. In June 2023 they published exact numbers for a different abuse case, 63 accounts and 3,806 instances. The difference between those two responses is whether you can count the damage. This session reproduces the counting on a 20 million row currency ledger in SQL Server 2022, seeding 60 abusing accounts inside a four hour incident window and comparing three detection queries against ground truth the queries never see. Reference reconciliation and open-log reconciliation both catch all 60 with zero false positives and reconstruct the exact clawback amount. Statistical outlier detection catches the same 60 but also flags 40 legitimate heavy users, because an abuser with five openings and twenty payouts is indistinguishable by sum from a heavy user with twenty openings and twenty payouts. Logical reads for the investigation query stay at 229,614 with no index and with three different indexes that all omit the reason column from the predicate, drop to 496 when reason is added to the key, and reach 482 with a filtered index at half the size, which silently reverts to a full scan when the querying session's SET options do not match."
date: 2026-08-07
tags:
  - SQL Server
  - MSSQL
  - Index
  - Filtered Index
  - Logical Reads
  - Game DB
  - Data Correction
  - Anomaly Detection
category: incident/QueryIndex
series: '게임 재화 사고, 탐지에서 보정까지'
seriesOrder: 1
coverImage: /uploads/incident/currency-anomaly-detection/fig-detect.png
---

## 무엇을 만들었고 무엇을 확인했나

**만든 것.** 게임 재화 원장 2,000만 행에서 이상 지급을 찾아 회수 대상을 산정하는 조사 랩입니다. 스크립트와 결과는 [incident-lab](https://github.com/dj258255/incident-lab) 의 `sessions/A24-currency-anomaly-detection` 에 있습니다.

**왜 했나.** 같은 성격의 재화 복사 사고에 어떤 회사는 서버를 6일 되돌리고 어떤 회사는 선별 회수를 합니다. 그 차이가 어디서 갈리는지 직접 밟아 보려고 했습니다.

**확인한 것 넷.**

| 질문 | 답 | 근거 |
|---|---|---|
| 참조 대사로 이상 계정을 다 찾을 수 있나 | 60/60, 오탐 0 | 정답지와 대조 |
| 통계적 이탈은 회수 근거가 되나 | 안 된다. 정상 계정 40개를 함께 지목 | 오탐 40 |
| 회수 금액까지 정확히 낼 수 있나 | 계정·건수·금액 모두 정답과 일치 | 360,000 |
| 조사 쿼리는 인덱스 없이 얼마나 읽나 | 229,614 페이지. 조건 컬럼을 담으면 482 | STATISTICS IO |

## 왜 이 문제가 갈리는가

게임에서 재화가 복사되면 회사는 둘 중 하나를 고릅니다. 서버를 사고 전 시점으로 되돌리거나, 부당 취득분만 골라 회수하거나.

2014년 1월 리니지 오크 서버에서 혈맹창고 버그로 아데나가 복사되자 엔씨소프트는 서버 전체를 6일 전 시점으로 되돌렸습니다([플레이포럼](https://www.playforum.net/news/articleView.html?idxno=1207)). 사고와 무관한 이용자의 6일치도 함께 사라졌습니다.

2022년 12월 28일 로스트아크에서는 상자 사용 횟수가 차감되지 않는 버그가 났습니다. 스마일게이트는 17분 만에 상자 사용을 제한하고 4시간 만에 수정한 뒤, 확인된 재화의 유통 과정을 조사해 선별 회수했습니다([게임톡](https://www.gametoc.co.kr/news/articleView.html?idxno=70572)). 이듬해 6월 얼음 석상 어뷰징에 대해서는 63개 계정 3,806회분이라는 숫자까지 붙여 공지했습니다([공식 공지 2432](https://lostark.game.onstove.com/News/Notice/Views/2432)).

전면 롤백을 피하려면 누가 얼마나 부당 취득했는지 정확히 셀 수 있어야 합니다. 못 세면 롤백 말고 선택지가 없습니다. **조사 쿼리의 정확도가 곧 대응 방식을 정합니다.**

## 재현

SQL Server 2022 컨테이너에 원장 2,000만 행(879MB)과 개봉 로그 1,000만 행을 넣었습니다. 계정 50만 개, 사고 창은 4시간입니다.

```
box_open_log    (open_id, account_id, box_id, opened_at)
currency_ledger (ledger_id, account_id, delta, reason, ref_id, created_at)
```

정상은 개봉 1건에 지급 1건이고, `ref_id` 가 `open_id` 를 가리킵니다. 사고의 흔적은 **같은 `ref_id` 에 지급이 여러 건 붙는 것**입니다. 버그 자체를 재현하지 않고 그 흔적만 만들었습니다.

사고 창 안에 이상 계정 60개를 심었습니다. 정답지는 별도 표에 두고 조사 쿼리는 그 표를 보지 않습니다.

이 랩은 ARM 에뮬레이션으로 돌기 때문에 **시간 수치는 인용하지 않습니다.** 대신 논리 읽기(페이지 수)를 봅니다. 같은 계획이면 어떤 하드웨어에서 돌든 같은 값이고, 정확도도 하드웨어와 무관합니다.

## 세 가지 조사 방법

![통계적 이상 탐지는 정상 헤비 이용자를 함께 지목한다](/uploads/incident/currency-anomaly-detection/fig-detect.png)

```
  방법         지목     적발       놓침       오탐
  A 참조 대사 60개      60/60        0개         0개
  B 통계 이탈 100개     60/60        0개         40개
  C 개봉 대사 60개      60/60        0개         0개
```

A는 원장 안에서 같은 `ref_id` 에 지급이 두 건 이상 붙은 것을 찾고, C는 개봉 로그와 원장을 조인해 "개봉 1건에 지급 1건"을 확인합니다. 둘은 같은 불변식을 다른 각도에서 보는 것이라 결과가 일치해야 합니다. 실제로 일치했습니다.

B는 창 안 획득량이 평균에서 3시그마를 넘는 계정을 찾습니다. 이상 계정 60개를 하나도 놓치지 않았는데 **정상 계정 40개를 함께 지목했습니다.**

창 안에서 상자를 20회 연 정상 이용자들입니다. 어뷰저는 5회 개봉에 지급 20건(1+3씩), 이들은 20회 개봉에 지급 20건입니다. 합계만 보면 구분되지 않습니다.

거짓 음성은 회수 누락이고 거짓 양성은 오회수입니다. 둘 다 사고이지만 무게가 다릅니다. 놓친 어뷰저는 나중에 잡을 수 있지만, 잘못 뺏은 재화는 이미 신뢰를 깎은 뒤입니다. **통계 이탈은 조사 대상을 좁히는 데 쓰고 회수 근거로는 쓰지 않습니다.**

### 계정만으로는 보정을 못 한다

회수하려면 얼마를 되돌릴지가 나와야 합니다. 첫 지급은 정상이므로 같은 `ref_id` 안에서 두 번째부터가 대상입니다.

```
  산정한 계정         60개
  정답과 건수·금액 일치 60개
  산정 회수액         360000
  정답 회수액         360000
```

계정 단위로 건수와 금액이 정답과 일치합니다. 이 표가 다음 글의 보정 절차에 그대로 입력으로 들어갑니다.

## 조사 쿼리는 얼마나 읽는가

재화 원장은 평소에 쓰기만 하는 append-only 표라 조사용 인덱스가 없는 경우가 많습니다. 사고가 나서야 처음 진지하게 조회합니다.

![인덱스를 만들었는데 안 쓰이는 자리](/uploads/incident/currency-anomaly-detection/fig-index.png)

```
  인덱스                          논리 읽기    인덱스 크기
  없음 (클러스터드 PK 만)    229614           0MB
  IX(ref_id)                         229614           426MB
  IX(created_at)                     227909           407MB
  IX(created_at, ref_id) 포함 account 228399           640MB
  IX(reason, created_at, ref_id) 포함 account 496              659MB
  필터드 (created_at, ref_id) WHERE reason=1 482              320MB
    위와 같되 조회에 SET 옵션 없음 229614           320MB
```

인덱스가 없으면 4시간 창을 보려고 30일치를 읽습니다. 창에 든 행은 전체의 0.6퍼센트인데 읽는 양은 전체의 두 배입니다. 조사 쿼리가 원장을 두 번 훑기 때문입니다.

**가운데 세 조건은 인덱스를 만들었는데도 읽는 양이 안 줄었습니다.** 셋 다 조건에 있는 `reason` 을 인덱스가 담지 않았습니다. 인덱스만으로 조회를 끝낼 수 없으니 옵티마이저가 표를 그냥 훑습니다. 640MB 를 쓰고도 한 번도 안 쓰인 인덱스이고, 쓰이지도 않으면서 쓰기마다 갱신 비용은 그대로 냅니다.

`reason` 을 키에 넣자 229,614에서 496으로 떨어집니다. 필터드 인덱스는 `reason = 1` 만 담아 크기가 절반인데 482로 더 적게 읽습니다.

![조사 쿼리의 논리 읽기](/uploads/incident/currency-anomaly-detection/fig-reads.png)

## 예상과 달랐던 점

### 통계적 탐지가 처음에는 오탐 0으로 나왔다

첫 판에서 B가 60개를 지목해 오탐이 하나도 없었습니다. 그대로 뒀으면 "통계적 탐지도 정확하다"는 결론이 표에 들어갔을 것입니다.

원인은 데이터였습니다. 계정 분포가 균등이라 어뷰저가 워낙 튀어서 3시그마로도 깨끗이 갈렸습니다. 실제 게임에는 정상인데 활동이 아주 많은 이용자가 있고, 그들이 오탐의 원천입니다. 그 계정군을 넣자 오탐 40개가 나왔습니다.

**데이터가 실제와 다르면 방법의 약점이 안 보입니다.** 이 실험이 재려던 것은 세 방법의 정확도였는데, 처음 데이터셋은 세 방법을 구분할 능력이 없었습니다.

### 필터드 인덱스는 SET 옵션이 안 맞으면 조용히 안 쓰인다

표의 마지막 줄이 이 실험에서 제일 조심할 자리입니다. 인덱스는 그대로 있는데 조회 쪽 `QUOTED_IDENTIFIER`, `ANSI_NULLS` 가 안 맞으면 필터드 인덱스는 쓰이지 않습니다. **에러가 나지 않고 그냥 안 쓰입니다.** 482에서 229,614로 돌아갑니다.

접속 도구마다 기본 SET 옵션이 달라서 "내 SSMS 에서는 빠른데 애플리케이션에서는 느리다"가 여기서 나옵니다.

### SQL 이 조용히 실패하고 스크립트는 계속 돌았다

적재 스크립트가 `QD "..." >/dev/null` 로 질의를 던졌는데 따옴표가 깨져 SQL 이 죽었습니다. `>/dev/null` 이 `Msg` 를 통째로 버려서 스크립트는 다음 단계로 넘어갔고, 데이터셋이 빈 채로 끝까지 돌았습니다.

`Msg` 가 보이면 멈추는 헬퍼를 만들어 쓰기 질의를 전부 그리로 돌렸습니다. 바로 다음 실행에서 `Msg 241` 이 화면에 떴고 원인이 한 번에 나왔습니다.

## 표준 처방

1. **회수 근거는 참조 대사나 개봉 대사로 만든다.** 통계 이탈은 조사 대상을 좁히는 데만 쓴다.
2. **조사 쿼리는 계정과 금액을 함께 낸다.** 계정 목록만으로는 보정 절차가 시작되지 않는다.
3. **조사용 인덱스를 평소에 하나 둔다.** 사고 중에 2,000만 행 표에 인덱스를 만드는 것은 그 자체가 위험한 작업이다.
4. **인덱스에 조건 컬럼을 빠뜨리지 않는다.** 조사 쿼리의 `WHERE` 에 있는 것은 전부 키나 포함 열에 있어야 한다. 하나 빠지면 인덱스 전체가 안 쓰인다.
5. **필터드 인덱스를 쓰면 조회 쪽 SET 옵션을 함께 못 박는다.** 안 맞으면 에러 없이 무시된다.

절차로 정리한 것은 저장소의 [운영 절차서](https://github.com/dj258255/incident-lab/blob/main/sessions/A24-currency-anomaly-detection/RUNBOOK.md)에 있습니다.

## 못 한 것

- **계정 분포가 균등합니다.** 정상 고활동 계정 40개를 넣어 오탐을 만들었지만 그 40개도 인위적으로 심은 것이라, 실제 분포에서 오탐이 몇 퍼센트인지는 말할 수 없습니다.
- **사고 유형이 하나입니다.** 참조가 아예 안 남는 사고는 A도 C도 못 잡습니다. 그때 B밖에 없다는 것이 통계적 탐지를 버리면 안 되는 이유인데, 그 조건을 만들지 않았습니다.
- **파티셔닝을 재지 않았습니다.** 인덱스로 이미 자릿수가 갈려 우선순위에서 밀렸습니다.
- **시간을 재지 않았습니다.** 조사 쿼리가 실제로 몇 초 걸리는지는 이 랩에서 답할 수 없습니다. "17분 만에 대응"이라는 실제 사례와 견주려면 그 값이 필요한데 비어 있습니다.
- **인덱스를 만드는 동안의 잠김을 재지 않았습니다.** 크기는 쟀지만 생성 비용은 안 쟀습니다.

다음 글에서는 이렇게 뽑은 회수 대상을 실제로 되돌립니다. 보정 배치가 서비스를 세우지 않게 하는 것부터입니다.
