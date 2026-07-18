---
title: '총량을 고정하고 축만 돌려서 재봤더니, 제 외삽은 틀렸고 급소는 소파일이 아니라 full-refresh였습니다'
titleEn: 'I Held the Volume Constant and Rotated the Axis, and My Extrapolation Was Wrong: the Weak Point Wasn''t Small Files but the Full Refresh'
description: '6편의 규모 실측은 시간축(dt)만 늘렸습니다. 365dt×6인스턴스. 그런데 셀프호스터가 몇백 대를 관제하는 사람이라면 늘어나는 축은 dt가 아니라 인스턴스 수(N)입니다. 저는 로드맵에 "소파일이 먼저 무너지고, 그다음 추출, 컴퓨트는 마지막"이라고 외삽해 뒀었는데, 그건 재보지 않은 문장이었습니다. 그래서 쟀습니다. 설계 핵심은 총량 고정·축 회전 — 6편이 2,190파일·54.5M행이었으니 N축을 7dt×300인스턴스=2,100파일·52.2M행으로 맞춰, 측정 차이가 전부 "축의 모양"(dt당 파일 6개→300개)으로 귀속되게 했습니다. 합성은 닫힌 dt의 실제 인스턴스를 순환 복제하되 instance_id를 리매핑하고 query_id에 suffix를 붙여 고유쿼리 카디널리티도 N에 비례해 자연 증가시켰고(9,039→26,700), 격리 프리픽스에만 써서 실데이터는 무손상입니다. 결과는 제 예상을 뒤집었습니다. 일상 경로(증분)는 N=300에서도 건재했습니다 — 새 dt 하나(300파일·7.5M행)가 8.03초, 워터마크 프루닝이 N축에서도 유효했습니다. 소파일도 아직 안 아팠습니다(177KB 동일 프로파일, 글롭·게이트 전부 초 단위 이하). 진짜 급소는 full-refresh였습니다. 같은 52~54M행인데 dt축 407.62초 vs N축 769.21초, 1.9배. 축의 모양만 바꿨는데 전체 재빌드가 두 배 아픕니다. dt당 행수가 149k에서 7.46M으로 커져 창 집계 압력이 dt 하나에 집중되는 게 가설인데, EXPLAIN 프로파일링 전까지는 가설로 남깁니다. 함의는 명확합니다 — 몇백 대 운영 가이드의 1순위는 "증분은 그대로 두고, backfill과 과거 정정을 dt 청크로 쪼개라"입니다. 추출 축은 원천 PG에 N인스턴스가 실재하지 않아 합성으로 못 쟀고, 그건 정직하게 남겼습니다.'
descriptionEn: 'Part 6''s scale test only grew the time axis: 365 dt × 6 instances. But if a self-hoster monitors hundreds of databases, the axis that grows is N, not dt. My roadmap said small files break first, then extraction, compute last — an extrapolation I had never measured. So I measured it. The key design was holding volume constant and rotating the axis: part 6 was 2,190 files / 54.5M rows, so I synthesized 7 dt × 300 instances = 2,100 files / 52.2M rows, making any difference attributable purely to the shape of the axis (6 files per dt vs 300). The synthesis cycles real closed-dt instances, remaps instance_id, suffixes query_id so unique-query cardinality grows naturally with N (9,039 → 26,700), and writes only to an isolated prefix. The results overturned my expectations. The daily path (incremental) held at N=300: one new dt (300 files, 7.5M rows) took 8.03s — watermark pruning survives the N axis. Small files didn''t hurt yet either (same 177KB profile; globs and gate all sub-second). The real weak point was the full refresh: same 52-54M rows, but 407.62s on the dt axis vs 769.21s on the N axis — 1.9x. Rotating the axis alone doubled the full rebuild. My hypothesis is that per-dt row volume jumped from 149k to 7.46M, concentrating window-aggregation pressure into each dt — a hypothesis until I profile with EXPLAIN. The implication is clear: for a fleet of hundreds, the first operational rule is "leave incremental alone; chunk your backfills and corrections by dt." The extraction axis couldn''t be measured synthetically (the source PG has no N instances), and I left that stated honestly.'
date: 2026-07-17
tags:
  - Data Engineering
  - dbt
  - DuckDB
  - Performance
  - Self-Hosting
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 8
---

## 0. 재보지 않은 문장이 로드맵에 있었다

7편에서 어플라이언스를 만들면서 저는 로드맵에 이런 표를 적었습니다. "N=100이면 소파일
압박 시작, N=300이면 소파일 심각, 무너지는 순서는 소파일 → 추출 → 컴퓨트." 몇백 대를
관제하는 조직이 이걸 셀프호스트하면 어디가 먼저 아픈지를 정리한 표였습니다.

그런데 그 표에는 각주가 하나 붙어 있었습니다. **"지금은 외삽이지 실측이 아니다."**
6편의 규모 실측은 시간축(dt)만 늘렸기 때문입니다. 365dt를 만들었지만 인스턴스는
6개 그대로였습니다. 몇백 대 시나리오에서 늘어나는 축은 dt가 아니라 **인스턴스
수(N)**인데, 그 축은 한 번도 재본 적이 없었습니다. 재보지 않은 문장을 표로 만들어
두면, 며칠 지나면 그게 사실처럼 읽힙니다. 6편에서 "빠를 것 같다"와 "빠르다"는 다른
문장이라고 써 놓고, 같은 실수를 축만 바꿔서 반복하고 있었던 셈입니다.

## 1. 총량을 고정하고 축만 돌린다

측정 설계에서 하나를 정했습니다. **총량 고정, 축 회전.**

6편의 dt축 실측은 2,190파일·54.5M행이었습니다. N축을 잴 때 아무 규모나 만들면
"N축이라서 느린 건지, 그냥 데이터가 많아서 느린 건지"를 분리할 수 없습니다. 그래서
N축 합성을 **7dt × 300인스턴스 = 2,100파일·52.2M행**으로 맞췄습니다. 파일 수도 행수도
6편과 거의 같습니다. 다른 건 축의 모양뿐입니다 — dt축은 "dt 365개, dt당 6파일",
N축은 "dt 7개, dt당 300파일". 이러면 측정값의 차이가 전부 축의 모양으로 귀속됩니다.

합성 방식은 6편의 스크립트에 `--instances N` 모드를 추가했습니다. 닫힌 dt의 실제
인스턴스 6개를 순환 복제하되, 세 가지를 리매핑합니다.

- `instance_id` → 1..N으로 갈아끼움
- `query_id` → `~i{j}` suffix — 인스턴스마다 자기 쿼리 모집단을 갖는 실제 배포처럼,
  고유쿼리 카디널리티가 N에 비례해 자연 증가합니다(실측: 1dt 기준 N=100에서 9,039개,
  N=300에서 26,700개)
- `id` → 인스턴스별 오프셋(전역 유일 유지)

악화 계수는 이번엔 안 심었습니다. 6편의 주입은 롤링 랭킹을 검증하려는 것이었고,
이번 측정 대상은 랭킹이 아니라 파이프라인 역학이기 때문입니다. 격리 원칙은
그대로입니다 — 별도 프리픽스 `scale_n/`에만 쓰고, 실데이터 `raw/`도 6편의 `scale/`도
건드리지 않고, 끝나면 프리픽스째 지웁니다.

## 2. 실측 — 예상 두 개가 틀렸다

N=100(700파일·17.7M행)과 N=300(2,100파일·52.2M행)을 만들어 6편과 같은 항목을
쟀습니다.

| 지표 | dt축(365dt×6) — 6편 | N=100(7dt) | N=300(7dt) |
|---|---|---|---|
| 파일 수 · 총 행수 | 2,190 · 54.5M | 700 · 17.7M | 2,100 · 52.2M |
| 파일 평균 크기 | 177KB | 180KB | **177KB** |
| **fct full-refresh** | **407.62s** | 68.08s | **769.21s** |
| **fct 증분(새 dt 1개)** | 4s | 2.98s | **8.03s** |
| mart 재빌드 | 0.31s | 0.22s | 0.12s |
| per-dt 글롭(게이트 단위) | 8~22ms | 154ms | 33ms* |

(*ms 단위 글롭 수치는 직전 쿼리가 메타데이터 캐시를 데워놨는지에 따라 흔들립니다.
N=300의 33ms는 바로 앞 전체 글롭이 캐시를 데운 상태입니다. 이 표에서 믿을 만한
신호는 초 단위 항목들입니다.)

![같은 총량에서 축만 회전한 비교 — full-refresh는 407.62초에서 769.21초로 1.9배가 되고, 증분은 4초에서 8.03초로 초 단위에 머문다](/uploads/project/lakehouse/lh12_axis_rotation.svg)

**첫 번째로 틀린 예상 — 소파일이 먼저 아플 것.** 안 아팠습니다. 파일 프로파일은
6편과 동일한 평균 177KB(실무 타깃 128MB의 1/741)인데, 전체 리스팅도 글롭도 게이트
단위 읽기도 전부 초 단위 이하였습니다. 소파일 폭증은 분명 실재하지만, 이 규모에선
아직 고통으로 나타나지 않습니다. "N=100이면 소파일 압박 시작"이라던 제 표는 최소한
이 스택·이 규모에선 겁이 많았습니다.

**두 번째로 틀린 예상 — 컴퓨트는 마지막일 것.** 정반대였습니다. fct 전체 재빌드가
**같은 총량에서 dt축 407.62초 vs N축 769.21초, 1.9배**입니다. 데이터를 한 바이트도
더 넣지 않고 축의 모양만 바꿨는데 전체 재빌드가 두 배 아픕니다.

## 3. 왜 두 배인가 — 가설까지만

원인을 파는 데는 신중하려고 합니다. 지금 가진 단서는 이렇습니다. fct는 하루 발생량을
"그날 파티션 안에서 쿼리별 first/last 차분"으로 구합니다. 창 집계가 dt 단위로 도는
구조입니다. dt축에선 dt당 149k행짜리 가벼운 창이 365개였습니다. N축에선 dt당
**7.46M행**짜리 무거운 창이 7개입니다. 창 하나에 들어오는 행이 50배라, 창 안의
정렬·해시·스필 압력이 dt 하나에 집중됩니다. 총합은 같아도 "잘게 365번"과 "무겁게
7번"은 메모리 거동이 다릅니다.

그럴듯하지만, EXPLAIN 프로파일링으로 확인한 게 아니므로 **가설로 남깁니다.** 6편에서
스칼라 서브쿼리 프루닝 실패를 파냈을 때처럼 플랜을 뜯어보면 확정할 수 있을 텐데,
그건 이 급소가 실제로 아파지는 시점(대량 backfill이 필요해지는 날)의 몫으로
미룹니다. 지금 단계에서 지어내지 않는 것이 더 중요합니다.

## 4. 그리고 예상대로였던 것 — 증분은 건재하다

숫자 하나가 이 실측 전체를 관통합니다. **N=300에서 새 dt 하나(300파일·7.5M행)의
증분 처리: 8.03초.**

6편에서 만든 증분 구조(delete+insert + 컴파일 타임 워터마크 리터럴)가 N축에서도
그대로 유효했습니다. 워터마크 프루닝이 최신 dt 파일만 읽으니, N이 6이든 300이든
"오늘 것만 계산한다"는 성질이 보존됩니다. N=100의 2.98초에서 N=300의 8.03초로,
대략 N에 선형입니다. 몇백 대 규모에서도 **매일 도는 경로는 안 무너집니다.**

mart도 마찬가지입니다. 어느 축에서도 0.1~0.3초. 입력이 사전집계(fct)라 축의 모양과
무관합니다. 6편에서 "문제 없는 곳을 최적화하지 않는다"고 남겨둔 판단이 N축에서도
유효하다는 재확인입니다.

## 5. 함의 — 운영 가이드의 1순위가 바뀐다

이 실측 전에 제 로드맵의 몇백 대 대응은 "컴팩션 노브와 추출 병렬도를 노출하라"였고,
full-refresh 청크 분할은 대응 목록의 한 줄이었습니다. 실측이 우선순위를 뒤집었습니다.

- **증분은 그대로 둔다.** 건드릴 이유가 없음을 수치가 보여줬습니다.
- **backfill·과거 정정이 진짜 위험 지점이다.** 증분 워터마크는 과거 dt 정정 시
  `--full-refresh`를 요구하는데(6편의 정직한 함정), 그 full-refresh가 N축에서 두 배
  아픕니다. N=300에서 12분 50초였고, 이력이 1년이면 이 숫자는 dt 수에 비례해
  커집니다. 몇백 대 어플라이언스의 운영 가이드 1순위는 **"full-refresh를 통째로
  돌리지 말고 dt 청크로 쪼개라"**가 됩니다.
- 소파일·글롭·게이트는 당분간 지켜보기만 합니다. 아직 수치가 최적화를 요구하지
  않습니다.

## 6. 남은 것을 정직하게

- **추출 축은 못 쟀습니다.** offload가 원천 PG를 인스턴스별로 조회하는 비용은 원천에
  N개 인스턴스가 실재해야 잴 수 있는데, 이 합성은 parquet 쪽만 만듭니다. "추출이 배치
  창을 넘기는 시점"은 실원천이 커질 때 재는 것으로 남깁니다.
- **769초의 원인은 가설입니다.** dt당 행수 집중이 창 집계를 짓누른다는 설명은
  그럴듯하지만 플랜으로 확인하지 않았습니다. EXPLAIN 프로파일링은 이 경로가 실제로
  아파질 때의 몫입니다.
- **ms 단위 글롭 수치는 캐시 온도에 오염됩니다.** 측정 순서가 결과에 섞여 들어서,
  표에서 그 줄은 참고치로만 남겼습니다. 초 단위 신호만 결론에 썼습니다.
- **카디널리티는 N에 비례하게 만들었지만, 쿼리 내용의 다양성은 여전히 복제입니다.**
  suffix로 고유쿼리 수는 늘렸어도 쿼리 텍스트 분포는 하루치의 반복입니다. 6편과 같은
  한계입니다.

---

이번 편에서 배운 건, 외삽에 각주를 달아두는 것만으로는 부족하고 결국 재봐야 한다는
것이었습니다. "소파일 먼저, 컴퓨트 마지막"이라는 제 표는 그럴듯했지만 두 군데가
틀렸고, 총량을 고정하고 축만 돌리는 설계 덕분에 그 틀림이 깨끗하게 드러났습니다.
증분이 건재하다는 확인과 full-refresh가 급소라는 발견은 같은 실측의 양면입니다.
하나는 안심하고 두는 근거가 됐고, 하나는 운영 가이드의 1순위가 됐습니다. 재보기 전엔
둘 다 몰랐습니다.
