---
title: '[SAA Ch-03] 고성능 아키텍처 설계: 병목이 어디인지 먼저 말하는 서비스를 고른다'
description: SAA-C03 영역 3(고성능 아키텍처, 채점 문항의 24%)을 시험 안내서의 과제 3.1~3.5 순서로 정리합니다. 스토리지, 컴퓨팅, 데이터베이스, 네트워크, 데이터 수집과 변환에서 자주 헷갈리는 서비스를 공식 문서의 수치와 조건으로 비교하고 시나리오 문구가 어느 서비스를 가리키는지 표로 묶었습니다. 직접 만든 확인 문제와 해설을 끝에 붙였습니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - AWS
  - SAA
  - Certification
  - Performance
  - EBS
  - Aurora
  - Kinesis
category: cert/SAA
topics:
  - cert
draft: false
series: "SAA 공부"
seriesOrder: 3
---

## 결론부터

1. 영역 3의 문제는 대부분 병목 하나를 문장 속에 숨겨 둡니다. "읽기가 몰린다", "연결이 폭주한다", "대륙을 건너 업로드한다", "같은 키를 반복해서 읽는다" 같은 문구가 병목의 위치를 알려 주고 정답은 그 자리를 넓히는 서비스입니다.
2. 스토리지는 접근 방식(객체, 파일, 블록)으로 먼저 나누고 그 다음에 수치로 고릅니다. gp3는 기본 3,000 IOPS와 125MiB/s를 크기와 따로 늘릴 수 있고 최대 80,000 IOPS입니다. 그보다 크거나 지연이 500마이크로초 아래여야 하면 io2 Block Express입니다. 인스턴스 스토어는 중지하면 데이터가 지워집니다.
3. 데이터베이스는 읽기 확장과 장애 조치를 구분해야 합니다. RDS 읽기 복제본은 비동기이고 자동으로 늘어나지 않습니다. Aurora 복제본은 같은 저장소를 공유해 지연이 보통 100밀리초보다 훨씬 작고 장애 조치 대상도 됩니다. 연결 수 문제는 RDS Proxy, 같은 키 반복 읽기는 DAX나 ElastiCache입니다.
4. 네트워크는 "HTTP 콘텐츠 캐시"면 CloudFront, "TCP/UDP와 고정 IP 2개"면 Global Accelerator입니다. VPN 터널 하나는 최대 1.25Gbps이고 Transit Gateway에서 ECMP로 묶을 수 있습니다. VPC 피어링은 전이 라우팅이 안 됩니다.
5. 데이터 수집은 빈도로 나눕니다. 실시간에 가깝고 다시 읽어야 하면 Kinesis Data Streams(샤드당 쓰기 1MB/s), 버퍼링해서 S3에 쌓으면 되면 Data Firehose, 이미 Kafka를 쓰면 MSK입니다. CSV를 Parquet으로 바꾸는 경로는 Firehose(JSON 입력, Lambda로 CSV 변환), Glue ETL, Athena CTAS 셋을 알아 둡니다.

---

## 1. 영역 3을 읽는 법

시험 안내서의 영역 3 페이지는 과제(Task Statement) 다섯 개로 나뉘고 과제마다 "Knowledge of"와 "Skills in" 목록이 붙어 있습니다(2026년 10월 19일 확인). 이 글의 2~6절은 그 다섯 과제를 순서대로 따라가고 소절은 각 과제의 지식과 기술 항목을 묶어 만들었습니다.

| 과제 | 안내서의 핵심 동사 | 이 글의 절 |
|---|---|---|
| 3.1 고성능 또는 확장 가능한 스토리지 | 성능 요구를 충족하는 스토리지와 설정을 정한다 | 2절 |
| 3.2 고성능이고 탄력적인 컴퓨팅 | 워크로드 분리, 확장 지표, 인스턴스 유형과 Lambda 메모리 선택 | 3절 |
| 3.3 고성능 데이터베이스 | 읽기 복제본, 엔진과 유형 선택, 캐싱 통합 | 4절 |
| 3.4 고성능 또는 확장 가능한 네트워크 | 글로벌, 하이브리드, 다계층 토폴로지와 로드 밸런싱 | 5절 |
| 3.5 고성능 데이터 수집과 변환 | 데이터 레이크, 스트리밍, 전송, 시각화, 형식 변환 | 6절 |

Ch-00에서 만든 비교표(SNS와 SQS, S3 클래스, Multi-AZ와 읽기 복제본, ALB와 NLB)는 여기서 다시 옮기지 않고 필요한 자리에서 한 줄로만 이어 붙입니다.

## 2. 과제 3.1 고성능 스토리지

### 2-1. 객체, 파일, 블록으로 먼저 나누기

안내서는 지식 항목으로 "스토리지 유형과 특성(객체, 파일, 블록)"과 "하이브리드 스토리지"를 듭니다. 문제에서 서비스 이름을 고르기 전에 애플리케이션이 데이터를 어떻게 여는지부터 봅니다.

| 접근 방식 | 서비스 | 붙는 대상 | 대표 문구 |
|---|---|---|---|
| 객체(HTTP API) | S3 | 어디서든 API로 | 정적 파일, 데이터 레이크, 무제한 용량 |
| 파일(NFS) | EFS | 여러 Linux 인스턴스가 동시에 마운트 | 공유 파일 시스템, 웹 서버 여러 대가 같은 업로드 디렉터리 |
| 파일(SMB, NFS, Lustre 등) | FSx 네 종류 | 프로토콜과 기존 파일 서버에 따라 | Windows 공유 폴더, HPC 고속 스크래치, NetApp 이관 |
| 블록(네트워크 볼륨) | EBS | 한 AZ의 인스턴스(io1/io2는 Multi-Attach 지원) | DB 데이터 디스크, 부트 볼륨 |
| 블록(호스트 로컬 디스크) | 인스턴스 스토어 | 그 호스트의 인스턴스 하나 | 캐시, 버퍼, 스크래치, 복제되는 임시 데이터 |

게시판 서비스로 예를 들면 첨부 파일 원본은 S3, 여러 웹 서버가 같이 쓰는 썸네일 작업 디렉터리는 EFS, 게시판 DB가 쓰는 디스크는 EBS로 나뉩니다.

### 2-2. S3 요청 성능: 접두사당 3,500 쓰기와 5,500 읽기

S3 사용자 가이드의 "Best practices design patterns: optimizing Amazon S3 performance"에 나오는 수치입니다.

- 분할된 접두사(prefix) 하나당 초당 최소 3,500건의 PUT/COPY/POST/DELETE와 5,500건의 GET/HEAD를 처리합니다. 버킷 안 접두사 개수에는 제한이 없습니다.
- 접두사를 10개로 나눠 병렬로 읽으면 읽기를 초당 55,000건까지 늘릴 수 있다고 문서가 예를 듭니다.
- 확장은 점진적으로 일어나고 그 사이 503(Slow Down) 응답이 나올 수 있습니다.
- 지연에 민감한 작은 객체는 대략 100~200밀리초 수준이고 한 자리 밀리초가 필요하면 CloudFront나 ElastiCache를 함께 쓰라고 적습니다.

S3 사용자 가이드의 다른 페이지 "Performance guidelines for Amazon S3"는 성능을 올리는 방법을 다섯 가지로 정리합니다.

| 방법 | 언제 쓰는지 |
|---|---|
| 연결을 수평으로 늘린다 | 버킷에 대한 연결 수 제한이 없으니 동시 요청을 여러 연결로 나눈다 |
| 바이트 범위 GET | 큰 객체를 여러 범위로 나눠 동시에 받는다. 멀티파트로 올린 객체는 같은 파트 크기로 받는 게 좋다 |
| 지연 민감 요청의 재시도 | 첫 요청이 느리면 다른 경로로 가는 재시도가 빨리 끝날 가능성이 높다 |
| 같은 리전에서 접근 | EC2와 버킷을 같은 리전에 두면 지연과 전송 비용이 줄어든다 |
| S3 Transfer Acceleration | 대륙을 건너는 업로드. CloudFront 엣지 로케이션으로 들어와 최적화된 경로로 S3에 간다(아래 표) |

Transfer Acceleration은 조건이 몇 가지 붙습니다. "Configuring fast, secure file transfers using Amazon S3 Transfer Acceleration" 문서(2026년 10월 20일 확인) 기준입니다.

| 항목 | 문서 내용 |
|---|---|
| 쓰는 경우 | 전 세계 고객이 중앙 버킷 하나로 업로드, 대륙을 건너 GB~TB를 정기 전송, 인터넷 대역폭을 다 쓰지 못함 |
| 버킷 이름 | DNS 호환이어야 하고 마침표(.)를 넣을 수 없다 |
| 엔드포인트 | `버킷이름.s3-accelerate.amazonaws.com`. 가상 호스팅 방식 요청만 지원 |
| 적용 시간 | 켠 뒤 속도가 오르기까지 최대 20분 |
| 요금 | 데이터 전송 요금이 추가될 수 있다 |
| 리전 | 서울(ap-northeast-2)을 포함한 15개 리전의 버킷 |

멀티파트 업로드는 큰 객체를 나눠 병렬로 올리는 방법이고 Transfer Acceleration은 먼 거리 경로를 줄이는 방법이라 둘을 함께 쓸 수 있습니다. 같은 리전 안 업로드가 느리다면 Transfer Acceleration은 답이 아닙니다.

지연이 한 자리 밀리초로 일정해야 하는 경우를 위해 S3 Express One Zone도 있습니다. 고성능 워크로드 페이지는 S3 Standard보다 접근 속도가 최대 10배 빠르고 요청 비용이 80% 낮다고 적고 스토리지 클래스 소개 페이지는 같은 비교를 50%로 적습니다(둘 다 2026년 10월 20일 확인). 문서끼리 숫자가 달라 "요청 비용이 Standard보다 낮다"까지만 기억해 둡니다. 단일 AZ의 디렉터리 버킷에 저장되고 설계 가용성은 99.95%입니다. AZ를 하나만 쓰니 내구성이나 가용성을 조건으로 건 문제에서는 오답이 됩니다.

### 2-3. EBS 볼륨 유형

EBS 사용자 가이드의 "Amazon EBS volume types" 표와 "Amazon EBS General Purpose SSD volumes" 페이지로 확인한 값입니다(2026년 10월). 예전 강의 자료에 많이 나오는 gp3 최대값(16,000 IOPS, 1,000MiB/s)은 지금 문서와 다르니 시험 직전에 다시 확인합니다.

| | gp3 | gp2 | io2 Block Express | io1 | st1 | sc1 |
|---|---|---|---|---|---|---|
| 매체 | SSD | SSD | SSD | SSD | HDD | HDD |
| 크기 | 1GiB~64TiB | 1GiB~16TiB | 4GiB~64TiB | 4GiB~16TiB | 125GiB~16TiB | 125GiB~16TiB |
| 최대 IOPS | 80,000 | 16,000 | 256,000 | 64,000 | 500(1MiB I/O) | 250(1MiB I/O) |
| 최대 처리량 | 2,000MiB/s | 250MiB/s | 4,000MiB/s | 1,000MiB/s | 500MiB/s | 250MiB/s |
| 내구성 | 99.8~99.9% | 99.8~99.9% | 99.999% | 99.8~99.9% | 99.8~99.9% | 99.8~99.9% |
| 부트 볼륨 | 가능 | 가능 | 가능 | 가능 | 불가 | 불가 |
| Multi-Attach | 불가 | 불가 | 가능 | 가능 | 불가 | 불가 |

gp3와 gp2는 성능이 정해지는 방식이 다릅니다.

- gp3는 기본 3,000 IOPS와 125MiB/s가 저장 요금에 포함되고 IOPS와 처리량을 크기와 따로 추가합니다. IOPS는 GiB당 500까지라서 80,000 IOPS를 받으려면 160GiB 이상이어야 합니다. 처리량은 IOPS당 0.25MiB/s까지라서 2,000MiB/s는 8,000 IOPS 이상에서 가능합니다. 버스트가 없고 프로비저닝한 성능을 계속 유지합니다.
- gp2는 GiB당 3 IOPS로 크기에 비례하고(최소 100, 최대 16,000) 1TiB보다 작은 볼륨은 I/O 크레딧으로 3,000 IOPS까지 버스트합니다. 크레딧이 떨어지면 기준 성능으로 돌아가니 `BurstBalance` 지표를 봅니다.
- io2 Block Express는 16KiB I/O 기준 평균 지연 500마이크로초 미만으로 설계됐습니다. 256,000 IOPS는 Nitro 기반 인스턴스에서만 받을 수 있습니다.

HDD 두 종류는 큰 순차 I/O용입니다. st1은 빅데이터, 데이터 웨어하우스, 로그 처리가 예시이고 sc1은 접근이 드물고 저장 비용이 가장 중요한 경우입니다. 둘 다 부트 볼륨으로 쓸 수 없다는 점이 보기 하나를 지우는 근거가 됩니다.

### 2-4. 인스턴스 스토어: 재부팅만 살아남는다

"Data persistence for Amazon EC2 instance store volumes" 문서는 이벤트별로 데이터가 남는지 표로 정리합니다.

| 이벤트 | 데이터 |
|---|---|
| 재부팅(사용자, 예약된 인스턴스 재부팅, 시스템 재부팅) | 남는다 |
| 중지, 최대 절전(hibernate), 종료 | 남지 않는다. 블록을 암호화 방식으로 지운다 |
| 인스턴스 유형 변경 | 남지 않는다 |
| 하위 디스크 장애 | 장애 난 디스크의 데이터는 남지 않는다 |
| 정전 | 재부팅 후 남는다 |

인스턴스 스토어는 추가 요금이 없고 호스트에 물리적으로 붙은 디스크라 지연이 낮습니다. 문서가 드는 용도는 버퍼, 캐시, 스크래치 데이터, 그리고 여러 인스턴스에 복제해 두는 임시 데이터입니다. "최고 I/O 성능이 필요하고 데이터는 다른 곳에 복제되어 있다"는 조건이면 인스턴스 스토어가 맞고 "인스턴스를 중지해도 보존"이 붙으면 EBS입니다. 인스턴스 이름 옵션의 `d`(예: m6id)가 인스턴스 스토어가 있다는 표시입니다.

### 2-5. EFS 처리량 모드: 기본은 Elastic

"Amazon EFS performance specifications" 문서 기준입니다.

| 모드 | 언제 고르는지(문서 표현 요약) |
|---|---|
| Elastic(권장, 기본) | 급증하거나 예측하기 어려운 부하, 평균 대비 최대 비율이 5% 이하 |
| Provisioned | 성능 요구를 알고 있거나 평균 대비 최대 비율이 5% 이상 |
| Bursting | 저장량에 비례하는 처리량이면 되는 경우. Standard 저장 GiB당 50KiBps 기준 |

성능 모드는 General Purpose와 Max I/O 두 가지인데 문서는 Max I/O를 이전 세대로 분류하고 모든 파일 시스템에 General Purpose를 권합니다. Max I/O는 지연이 더 길고 One Zone이나 Elastic 처리량과 함께 쓸 수 없습니다. 오래된 강의에서 "병렬 처리가 많으면 Max I/O"라고 배웠다면 지금 문서와 다르다는 점을 기억해 둡니다.

Regional 파일 시스템의 Elastic 모드는 읽기 지연이 약 1밀리초, 쓰기 약 2.7밀리초이고 클라이언트당 최대 1,500MiBps(EFS 클라이언트 2.0 이상으로 마운트할 때)입니다. 이 값은 최적 조건 기준이라고 문서가 적습니다.

### 2-6. FSx 네 종류

AWS의 "Help Me Choose An Amazon FSx File System" 페이지를 기준으로 정리했습니다.

| | FSx for Lustre | FSx for Windows File Server | FSx for NetApp ONTAP | FSx for OpenZFS |
|---|---|---|---|---|
| 지금 쓰는 것 | Lustre 등 병렬 파일 시스템, 아주 높은 처리량 | Windows Server 파일 서버 | NetApp ONTAP 등 NAS | ZFS 등 Linux 파일 서버 |
| 프로토콜 | POSIX 호환 전용 프로토콜(Linux 클라이언트) | SMB | SMB, NFS, iSCSI | NFS |
| 눈여겨볼 기능 | S3 데이터셋 자동 가져오기와 내보내기 | Active Directory 통합, NTFS ACL | 다중 프로토콜, 콜드 데이터용 저비용 계층, SnapMirror | 0.5ms 미만 지연, 즉시 복제(clone) |

시험 문구로 바꾸면 "HPC, 머신러닝 학습, S3에 있는 데이터를 고속 파일 시스템으로"는 Lustre, "SMB와 AD"는 Windows File Server, "NFS와 SMB를 같은 데이터에", "온프레미스 NetApp"은 ONTAP입니다.

### 2-7. 하이브리드 스토리지: Storage Gateway 유형

Storage Gateway 문서는 파일(S3 File Gateway, FSx File Gateway), 볼륨(Volume Gateway), 테이프(Tape Gateway) 세 갈래로 나눕니다.

| 유형 | 온프레미스에서 보이는 모습 | 데이터가 사는 곳 |
|---|---|---|
| S3 File Gateway | NFS, SMB 파일 공유 | S3 객체 |
| FSx File Gateway | SMB 공유 | FSx for Windows File Server. 2026년 10월 기준 신규 고객에게는 제공하지 않는다 |
| Volume Gateway 캐시 볼륨 | iSCSI 볼륨 | 주 데이터는 S3, 자주 쓰는 일부만 로컬 캐시 |
| Volume Gateway 저장 볼륨 | iSCSI 볼륨 | 전체 데이터는 로컬, 시점 스냅샷을 비동기로 S3에 백업 |
| Tape Gateway | 가상 테이프 라이브러리 | S3와 아카이브 클래스 |

캐시 볼륨과 저장 볼륨의 차이가 자주 나옵니다. "전체 데이터셋에 낮은 지연으로 접근"이면 저장 볼륨, "온프레미스 용량을 늘리지 않고 자주 쓰는 데이터만 빠르게"면 캐시 볼륨입니다. FSx File Gateway를 신규로 쓸 수 없다는 공지는 2026년 10월 문서에서 확인했고 시험 문항이 이 변경을 반영했는지는 모릅니다.

### 2-8. 시험에서 갈리는 조건(스토리지)

| 시나리오 문구 | 고를 것 | 이유 |
|---|---|---|
| 대륙 반대편 사용자가 큰 파일을 버킷 하나에 업로드 | S3 Transfer Acceleration 또는 멀티파트 업로드 | 엣지로 들어와 최적 경로로 전송 |
| 같은 접두사에 요청이 몰려 503 Slow Down | 접두사를 나눠 병렬화 | 접두사당 3,500/5,500 요청 |
| DB 볼륨에 일정한 20,000 IOPS, 비용 효율 | gp3(IOPS 추가 프로비저닝) | 80,000까지 크기와 따로 설정 |
| 100,000 IOPS 이상, 지연 1밀리초 미만 지속 | io2 Block Express | 256,000 IOPS, 500마이크로초 미만 |
| 로그를 큰 블록으로 순차 처리, 부트 아님 | st1 | 500MiB/s, HDD |
| 임시 정렬 파일, 최저 지연, 잃어도 됨 | 인스턴스 스토어 | 로컬 디스크, 중지하면 삭제 |
| Linux 웹 서버 여러 대가 같은 디렉터리 공유 | EFS | NFS 동시 마운트 |
| Windows 앱의 SMB 공유, AD 인증 | FSx for Windows File Server | SMB, AD 통합 |
| 온프레미스 앱이 iSCSI로 쓰고 백업은 클라우드로 | Volume Gateway | 캐시 또는 저장 볼륨 |

## 3. 과제 3.2 고성능이고 탄력적인 컴퓨팅

### 3-1. EC2 인스턴스 이름 읽기

"Amazon EC2 instance type naming conventions" 문서는 `c7gn.xlarge`를 예로 듭니다. 첫 글자가 시리즈, 숫자가 세대, 그 뒤가 옵션, 점 뒤가 크기입니다.

| 시리즈 | 뜻 | 시험 문구 |
|---|---|---|
| M | 범용 | 균형 잡힌 웹 서버, 특별한 병목 없음 |
| C | 컴퓨팅 최적화 | 배치 연산, 동영상 인코딩, 과학 모델링 |
| R, X, U, Z | 메모리 최적화, 고메모리 | 인메모리 캐시, 큰 메모리 DB |
| I, D | 스토리지 최적화, 고밀도 스토리지 | 로컬 디스크 I/O가 큰 NoSQL, 데이터 웨어하우스 |
| P, G, Inf, Trn | GPU, 그래픽, Inferentia, Trainium | 머신러닝 학습과 추론, 그래픽 |
| T | 버스트 가능 | 평소 한가하고 가끔 바쁜 개발 서버 |
| Hpc | 고성능 컴퓨팅 | 노드 사이 통신이 많은 HPC |

옵션 글자 중 시험에 쓸모 있는 것은 `g`(Graviton), `a`(AMD), `i`(Intel), `d`(인스턴스 스토어), `n`(네트워크와 EBS 최적화)입니다.

### 3-2. 배치 그룹 세 가지

"Placement strategies for your placement groups" 문서 기준입니다. 2026년 10월 문서에는 정밀 시간(precision time) 배치 그룹이 하나 더 있는데 시험 안내서에는 배치 그룹이 직접 나오지 않아 세 가지만 표로 정리했습니다.

| | 클러스터 | 파티션 | 분산(spread) |
|---|---|---|---|
| 목적 | 낮은 지연, 높은 처리량 | 상관된 하드웨어 장애 격리 | 소수의 핵심 인스턴스를 서로 다른 랙에 |
| AZ | 단일 AZ만 | 같은 리전의 여러 AZ 가능 | 여러 AZ 가능 |
| 한도 | 계정 한도 | AZ당 파티션 최대 7개 | 랙 단위 분산은 AZ당 실행 중 인스턴스 최대 7개 |
| 예시 워크로드 | HPC, 노드 간 트래픽이 대부분인 앱 | HDFS, HBase, Cassandra | 서로 따로 죽어야 하는 소수의 서버 |

클러스터 배치 그룹 안에서 향상된 네트워킹 인스턴스는 단일 흐름에 최대 10Gbps를 쓰고 밖에서는 5Gbps입니다. 문서는 한 번의 시작 요청으로 같은 유형을 한꺼번에 띄우라고 권하고 나중에 추가하면 용량 부족 오류가 날 가능성이 커진다고 적습니다.

### 3-3. Auto Scaling 정책: 대상 추적이 기본값

EC2 Auto Scaling의 동적 조정 정책은 대상 추적(target tracking), 단계(step), 단순(simple) 세 가지이고 따로 예약(scheduled)과 예측(predictive) 조정이 있습니다. 문서는 대상 추적을 강하게 권하면서 지표 고르는 기준을 하나 줍니다. 그룹 크기를 두 배로 늘리면 50% 줄어드는 지표, 즉 용량에 반비례하는 지표여야 합니다. 평균 CPU 사용률이나 대상당 요청 수가 그 예입니다.

안내서 기술 항목 "확장 동작을 수행할 지표와 조건 식별"은 이 기준으로 풀립니다.

| 상황 | 지표나 방식 |
|---|---|
| 웹 계층, 부하가 고르게 분산 | 대상 추적: 평균 CPU 또는 ALB 대상당 요청 수 |
| SQS 큐를 소비하는 작업자 | 인스턴스당 큐 메시지 수(백로그)로 대상 추적. 문서에 "Scaling policy based on Amazon SQS" 항목이 있다 |
| 매주 월요일 9시에 부하 급증 | 예약 조정 |
| 일정한 패턴이 반복되는 부하 | 예측 조정 |
| 경보 초과 폭에 따라 다르게 추가 | 단계 조정 |

정책이 여러 개 동시에 발동하면 Auto Scaling은 확장과 축소 모두에서 더 큰 용량을 주는 정책을 따릅니다. 너무 많이 줄이는 일을 막으려는 규칙입니다.

### 3-4. 워크로드 분리와 게시/구독

안내서 기술 항목 첫 줄이 "구성 요소가 독립적으로 확장되도록 워크로드를 분리"입니다. 쇼핑몰 주문 접수와 결제 승인을 직접 호출로 묶으면 결제 계층이 느려질 때 주문 접수도 같이 느려집니다. 둘 사이에 SQS 큐를 두면 주문 접수는 큐에 넣고 바로 응답하고 결제 작업자는 큐 길이에 맞춰 따로 늘어납니다. 주문 완료 이벤트를 재고, 알림, 정산이 각자 받아야 하면 SNS 토픽 아래 SQS 큐 여러 개를 다는 팬아웃입니다. SNS, SQS, Kinesis, MSK의 차이는 Ch-00 4-2절 표에 있습니다.

### 3-5. Lambda 메모리와 한도

"Configure Lambda Event Function memory"와 "Lambda quotas" 문서 기준입니다.

| 항목 | 값 |
|---|---|
| 메모리 | 128MB~10,240MB, 1MB 단위. CPU는 메모리에 비례해 할당 |
| 1 vCPU에 해당하는 메모리 | 1,769MB |
| 최대 실행 시간 | 900초(15분) |
| 리전당 기본 동시 실행 | 1,000(늘릴 수 있음) |
| `/tmp` 저장 공간 | 512MB~10,240MB |
| 동기 호출 페이로드 | 요청과 응답 각 6MB |

안내서 기술 항목에 "Lambda 메모리 양"이 예시로 직접 나옵니다. 문서는 메모리가 함수 성능을 조절하는 주된 손잡이라고 적고 CPU, 네트워크, 메모리 중 무엇에 묶인 함수든 메모리를 올리면 성능이 크게 좋아질 수 있다고 설명합니다. 그래서 "Lambda 함수가 CPU를 많이 써서 느리다"는 문제의 답은 메모리 증가입니다. 15분보다 오래 걸리는 작업은 Lambda에서 빼서 Fargate, Batch, EC2로 옮깁니다.

### 3-6. 컨테이너: ECS, EKS, Fargate

Fargate 문서는 Fargate를 "서버나 EC2 클러스터를 관리하지 않고 컨테이너를 실행하는 기술"로 정의합니다. 작업마다 격리 경계를 따로 가지며 커널, CPU, 메모리, ENI를 다른 작업과 공유하지 않습니다. Fargate Spot은 남는 용량에서 할인된 가격으로 돌고 회수될 때 2분 전에 경고를 받습니다.

| 질문 | 답 |
|---|---|
| 오케스트레이터를 무엇으로 | Kubernetes API와 생태계가 필요하면 EKS, AWS 고유 방식으로 단순하게 가면 ECS |
| 노드를 누가 관리 | 서버 관리를 없애려면 Fargate, 인스턴스 유형을 고르거나 GPU가 필요하면 EC2 |
| ALB 대상 유형 | Fargate 작업은 `awsvpc` 네트워크 모드라서 대상 유형을 `ip`로 한다 |

### 3-7. 배치 처리: AWS Batch와 EMR

AWS Batch 문서는 Batch를 제출된 작업에 맞춰 자원을 프로비저닝하는 완전 관리형 배치 서비스로 설명하고 EC2(On-Demand, Spot), Fargate, ECS, EKS 위에서 돈다고 적습니다. EMR은 Hadoop과 Spark 같은 빅데이터 프레임워크를 돌리는 관리형 클러스터 플랫폼입니다.

| 조건 | 고를 것 |
|---|---|
| 컨테이너로 만든 독립 작업 수천 개, 큐와 우선순위 | AWS Batch |
| Spark, Hive, Hadoop 코드가 이미 있음, 페타바이트 규모 | EMR |
| 서버리스 Spark ETL, 카탈로그 연동 | Glue(6-6절) |
| 15분 안에 끝나는 이벤트 처리 | Lambda |

### 3-8. 시험에서 갈리는 조건(컴퓨팅)

| 시나리오 문구 | 고를 것 |
|---|---|
| 노드 간 지연이 가장 낮아야 하는 HPC | 클러스터 배치 그룹, 향상된 네트워킹 |
| Cassandra 노드를 랙 장애 단위로 나눔 | 파티션 배치 그룹 |
| 핵심 서버 3대가 같은 하드웨어를 공유하면 안 됨 | 분산 배치 그룹 |
| 주문 처리 계층이 따로 늘어나야 함 | SQS로 분리하고 큐 길이로 확장 |
| Lambda가 CPU 바운드로 느림 | 메모리 증가 |
| 컨테이너를 서버 관리 없이 | Fargate |
| 작업 하나가 2시간 걸리는 이미지 처리 | Batch 또는 ECS/Fargate. Lambda는 15분 한도 |

## 4. 과제 3.3 고성능 데이터베이스

### 4-1. 접근 패턴으로 유형 고르기

안내서는 "데이터 접근 패턴(읽기 위주와 쓰기 위주)"과 "DB 유형(서버리스, 관계형과 비관계형, 인메모리)"을 지식 항목으로 듭니다.

| 패턴 | 유형 | 서비스 |
|---|---|---|
| 조인과 트랜잭션, 스키마가 정해진 주문과 결제 | 관계형 | RDS, Aurora |
| 키로 조회, 초당 요청이 크게 변함, 스키마 유연 | 키-값, 문서 | DynamoDB |
| 마이크로초 응답, 세션, 순위표 | 인메모리 | ElastiCache, DAX(DynamoDB 앞) |
| 읽기가 쓰기보다 훨씬 많음 | 관계형 + 읽기 복제본 또는 캐시 | Aurora 복제본, ElastiCache |

### 4-2. RDS 읽기 복제본

"Working with DB instance read replicas"와 RDS 할당량 문서에서 확인한 내용입니다.

- 원본의 변경을 비동기로 복제하고 읽기 전용 연결만 받습니다. Db2와 Oracle은 사용자 연결을 받지 않는 대기(mounted, standby) 복제본도 있고 주 용도는 리전 간 재해 복구입니다.
- 원본 인스턴스당 읽기 복제본 기본 할당량은 15개입니다. Oracle은 15개까지 만들 수 있지만 복제 지연을 줄이려면 5개로 제한하라고 권합니다.
- 읽기 복제본은 자동으로 늘거나 줄지 않습니다. 직접 만들고 직접 지웁니다.
- 같은 리전 안 원본과 복제본 사이의 복제 데이터 전송에는 요금이 없습니다. 복제본 자체는 같은 인스턴스 클래스 요금을 냅니다.
- 다른 리전에 둘 수 있고 독립 인스턴스로 승격할 수 있어 DR에도 씁니다.

엔진별 차이 중 시험에 쓸 만한 것을 "Differences between read replicas for DB engines"에서 뽑았습니다.

| | MySQL, MariaDB | PostgreSQL | Oracle, SQL Server |
|---|---|---|---|
| 복제 방식 | 논리 복제 | 물리 복제 | 물리 복제 |
| 복제본을 쓰기 가능하게 | 가능 | 불가 | 불가(승격하면 가능) |
| 복제본의 복제본 | 가능 | 일부 버전 가능 | 불가 |

Multi-AZ 대기 인스턴스는 동기 복제이고 읽기를 처리하지 않는다는 점은 Ch-00에서 정리했습니다. 문서도 "읽기 복제본과 달리 대기 복제본은 읽기 트래픽을 처리할 수 없다"고 적습니다.

### 4-3. Aurora의 공유 저장소와 복제본

Aurora 문서("Amazon Aurora storage", "Replication with Amazon Aurora", "How Aurora serverless works")에서 확인한 사실입니다.

- 클러스터 볼륨은 한 리전의 AZ 3개에 걸친 사본으로 구성됩니다. 서버리스 문서는 이를 "AZ 3개에 걸친 데이터 사본 6개"라고 적습니다. Ch-00에서 확인하지 못했던 사본 개수를 이번에 확인했습니다.
- 클러스터당 Aurora 복제본은 최대 15개이고 리더 엔드포인트로 읽기 연결을 분산합니다.
- 복제본이 같은 볼륨을 보기 때문에 복제 지연은 보통 100밀리초보다 훨씬 작습니다. 쓰기가 몰리면 늘어날 수 있습니다.
- 라이터가 실패하면 복제본 하나를 승격합니다. 복제본이 없으면 인스턴스가 복구될 때까지 클러스터를 쓸 수 없습니다.
- 리전 간 확장은 Aurora Global Database입니다. 2026년 10월 사용자 가이드는 엔진을 가리지 않고 다른 리전에 읽기 전용 보조 클러스터를 최대 10개 둘 수 있다고 적습니다(2021년판 DR 백서는 5개, Ch-02 3-8절).

Aurora 저장 구성에는 Standard와 I/O-Optimized 두 가지가 있습니다. 문서는 I/O 지출이 Aurora 전체 지출의 25% 이상이면 I/O-Optimized, 25% 미만이면 Standard가 낫다고 적습니다. 이 기준은 비용 영역(Ch-04)에서 다시 씁니다.

### 4-4. RDS Proxy: 연결을 모아 쓰기

"Amazon RDS Proxy" 문서는 연결 풀을 만들어 재사용하고 새 연결마다 드는 메모리와 CPU를 아낀다고 설명합니다. 풀에서 바로 처리할 수 없는 연결은 대기열에 넣거나 조절하고 한도를 넘으면 거부합니다. 장애 조치 때 애플리케이션 연결을 유지한 채 대기 인스턴스로 붙고 IAM 인증과 Secrets Manager 자격 증명을 쓸 수 있습니다.

시험에 쓸 제약도 같은 문서에 있습니다.

| 제약 | 내용 |
|---|---|
| 위치 | DB와 같은 VPC. 프록시는 공개 접근 불가 |
| 복제 구성 | 라이터 인스턴스에만 연결. 읽기 복제본에는 붙일 수 없다 |
| 기본 엔드포인트 | 두 AZ에 프로비저닝 |
| 계정당 프록시 | 기본 20개 |

"Lambda 함수 수천 개가 동시에 DB 연결을 열어 `max_connections`를 넘는다"는 문제가 RDS Proxy의 전형입니다. RDS 할당량 문서도 연결을 자주 열고 닫거나 오래 유지하는 연결이 많으면 RDS Proxy를 권합니다.

### 4-5. DynamoDB 용량 모드와 DAX

"DynamoDB throughput capacity" 문서는 온디맨드 모드를 대부분의 워크로드에 기본으로 권장하는 옵션으로 소개합니다. 요청당 요금을 내고 처리량을 미리 지정하지 않습니다. 프로비저닝 모드는 초당 읽기와 쓰기를 지정하고 사용량과 관계없이 프로비저닝한 시간당 용량에 요금을 냅니다. 예측 가능한 꾸준한 부하에 맞습니다. 안내서 지식 항목의 "용량 단위"가 이 프로비저닝 모드의 RCU와 WCU입니다.

DAX는 DynamoDB와 API가 호환되는 인메모리 캐시입니다. DAX 문서가 적는 용도와 맞지 않는 경우를 함께 봐야 합니다.

| DAX가 맞는 경우 | DAX가 맞지 않는 경우 |
|---|---|
| 최종 일관성 읽기의 응답을 한 자리 밀리초에서 마이크로초로 | 강한 일관성 읽기가 필요한 앱 |
| 하루 특가 상품처럼 소수 키에 읽기가 몰림 | 쓰기 위주 앱 |
| 읽기 비용을 줄이려고 RCU 과다 프로비저닝을 피함 | 같은 키 반복 읽기가 적은 앱. 캐시 적중률 90% 이상에서 가장 잘 동작 |

### 4-6. ElastiCache: Memcached와 Valkey/Redis OSS

ElastiCache 문서("Comparing node-based Valkey, Memcached, and Redis OSS clusters")는 엔진을 고르는 조건을 이렇게 줍니다.

| | Memcached | Valkey 또는 Redis OSS |
|---|---|---|
| 고르는 조건 | 가장 단순한 모델, 멀티코어 큰 노드, 노드를 넣고 빼며 확장, 객체 캐싱 | 복잡한 자료형, 복제와 장애 조치, 백업, 게시/구독 |
| 멀티스레드 | 예 | 아니요 |
| 복제(고가용성) | 아니요 | 예 |
| 자동 장애 조치 | 아니요 | 클러스터 모드 비활성은 선택, 활성은 필수 |
| 백업과 복원 | 서버리스 캐시만 | 예 |
| 정렬 집합, 게시/구독, 지리 공간 | 아니요 | 예 |

2026년 10월 문서 이름은 Valkey가 앞에 오고 Redis OSS가 뒤에 옵니다. 시험 문구가 "Redis"라고 써도 같은 엔진 계열입니다. 게임 순위표(정렬 집합), 장애 시 캐시 데이터 보존, 다중 AZ 복제가 조건이면 Valkey/Redis OSS이고 "단순 객체 캐시, 멀티스레드"면 Memcached입니다.

캐싱 전략은 두 가지를 구분해 둡니다. 지연 로딩(lazy loading)은 캐시에 없을 때만 DB에서 읽어 넣고 라이트 스루(write-through)는 DB에 쓸 때 캐시도 같이 갱신합니다. ElastiCache 문서의 "Caching strategies" 페이지 기준 장단점은 Ch-02 2-11절 표에 정리했습니다.

### 4-7. 엔진 선택과 이관

안내서는 "동종 이관과 이종 이관"과 "MySQL과 PostgreSQL 비교"를 예로 듭니다. DMS 문서는 다른 엔진으로 옮길 때 DMS Schema Conversion(또는 내려받아 쓰는 AWS SCT)으로 스키마를 변환하고 DMS로 데이터를 옮긴다고 설명합니다. 일회성 이관과 지속 복제(변경분 동기화) 둘 다 됩니다.

| 이관 | 도구 |
|---|---|
| 온프레미스 MySQL에서 RDS for MySQL(동종) | DMS. 스키마 변환 불필요 |
| Oracle에서 Aurora PostgreSQL(이종) | DMS Schema Conversion 또는 SCT로 스키마, DMS로 데이터 |
| 이관 중 다운타임 최소화 | DMS 지속 복제로 원본과 대상을 맞춘 뒤 전환 |

엔진 선택 자체에 대해 4-2절 표가 하나의 근거가 됩니다. 복제본을 쓰기 가능하게 하거나 복제본의 복제본을 만드는 구성이 필요하면 MySQL 계열이 더 유연합니다. 그 외 MySQL과 PostgreSQL의 기능 비교는 공식 문서에 한 표로 정리된 곳을 찾지 못해 이 글에서는 다루지 않았습니다.

### 4-8. 시험에서 갈리는 조건(데이터베이스)

| 시나리오 문구 | 고를 것 |
|---|---|
| 보고서 쿼리가 운영 DB를 느리게 함 | 읽기 복제본(RDS) 또는 Aurora 복제본에 보고서 연결 |
| 읽기 확장과 빠른 장애 조치를 한 번에 | Aurora 복제본 |
| 다른 리전에 읽기 전용 사본, 리전 단위 DR | Aurora Global Database |
| 서버리스 함수의 연결 폭주 | RDS Proxy |
| DynamoDB 인기 상품 키에 읽기 집중, 마이크로초 | DAX |
| 세션 저장과 순위표, 복제 필요 | ElastiCache for Valkey/Redis OSS |
| 단순 객체 캐시, 노드 추가로 수평 확장 | ElastiCache for Memcached |
| Oracle을 PostgreSQL로 | DMS Schema Conversion(SCT)과 DMS |

## 5. 과제 3.4 고성능 네트워크

### 5-1. 서브넷 계층과 자원 배치

안내서 지식 항목은 "서브넷 계층, 라우팅, IP 주소 체계"를 예로 듭니다. 다계층(multi-tier) 쇼핑몰이라면 인터넷을 마주하는 ALB만 공용 서브넷에 두고 웹과 애플리케이션 서버, DB는 사설 서브넷에 둡니다. 계층마다 AZ 2개 이상에 서브넷을 만들고 사설 서브넷의 아웃바운드는 NAT 게이트웨이로 보냅니다. S3와 DynamoDB로 가는 트래픽은 게이트웨이 엔드포인트로 돌리면 NAT를 거치지 않습니다(비용은 Ch-04). VPC를 여러 개 연결할 계획이면 VPC마다 CIDR 범위를 서로 다르게 처음부터 나눠 둡니다. 피어링은 CIDR이 겹치면 만들 수 없기 때문입니다(5-4절).

### 5-2. CloudFront와 Global Accelerator

둘 다 AWS 엣지 로케이션을 쓰지만 다루는 트래픽이 다릅니다.

| | CloudFront | Global Accelerator |
|---|---|---|
| 하는 일 | 엣지에서 콘텐츠를 캐시해 전달 | 엣지에서 받은 TCP/UDP를 AWS 백본으로 엔드포인트까지 |
| 프로토콜 | HTTP, HTTPS | TCP, UDP |
| 진입 주소 | 배포 도메인 이름 | 고정 애니캐스트 IPv4 주소 2개 |
| 장애 조치 | 오리진 그룹 | 비정상 엔드포인트를 1분 안에 제외하고 설정 변경은 몇 초 안에 전파(FAQ) |
| 맞는 경우 | 정적과 동적 웹 콘텐츠, 이미지, 동영상 | 게임(UDP), IoT(MQTT), VoIP, 고정 IP 허용 목록이 필요한 API |

CloudFront 문서는 요청을 지연이 가장 낮은 엣지로 보내고 캐시에 없으면 오리진에서 가져온다고 설명합니다. 기본 캐시 기간은 24시간이고 헤더로 바꿀 수 있습니다. Global Accelerator FAQ는 HTTP가 아닌 경우(게임, IoT, VoIP)에 잘 맞는다고 적습니다. "고정 IP", "UDP", "여러 리전 엔드포인트 사이 빠른 장애 조치"가 보이면 Global Accelerator입니다.

### 5-3. 하이브리드 연결: VPN과 Direct Connect

| | Site-to-Site VPN | Direct Connect |
|---|---|---|
| 경로 | 인터넷 위 IPsec 터널 | 전용 물리 회선 |
| 대역폭 | 표준 터널당 최대 1.25Gbps, 대역폭 큰 터널은 최대 5Gbps | 전용 연결 1, 10, 100, 400Gbps. 호스티드 연결은 파트너가 제공 |
| 개통 | 빠르다 | AWS 검토에 최대 72영업시간. 그 뒤 회선 작업 |
| 대역폭 늘리기 | Transit Gateway에서 ECMP로 터널을 묶는다(동적 라우팅 필요) | LAG로 여러 연결을 하나처럼 |
| 암호화 | IPsec | 전용 연결에서 MACsec 선택 가능 |

VPN 할당량 문서는 Transit Gateway에 붙은 VPN 연결이 ECMP로 여러 터널을 묶어 대역폭을 늘릴 수 있고 정적 라우팅에서는 ECMP가 지원되지 않는다고 적습니다. 가상 프라이빗 게이트웨이는 VPC 하나에만 붙으니 같은 VPN을 VPC 여러 개에 쓰려면 Transit Gateway를 권합니다.

자주 나오는 조합은 Direct Connect를 주 경로로 두고 Site-to-Site VPN을 백업 경로로 두는 구성입니다. "일관된 대역폭과 지연"은 Direct Connect, "며칠 안에 연결", "비용이 낮은 암호화 연결"은 VPN입니다.

### 5-4. VPC 피어링, Transit Gateway, PrivateLink

VPC 피어링 문서("How VPC peering connections work")의 제약이 문제를 풉니다.

- 피어링은 VPC 둘 사이의 일대일 관계이고 전이 피어링을 지원하지 않습니다. A와 B, A와 C가 피어링돼 있어도 B에서 A를 거쳐 C로 갈 수 없습니다.
- CIDR이 겹치면 만들 수 없습니다.
- 엣지 투 엣지 라우팅도 안 됩니다. B는 A의 인터넷 게이트웨이, NAT, VPN, Direct Connect, S3 게이트웨이 엔드포인트를 빌려 쓸 수 없습니다.

Transit Gateway는 VPC와 온프레미스 네트워크를 잇는 허브입니다. VPC, VPN, Direct Connect 게이트웨이, 다른 Transit Gateway와의 피어링을 연결(attachment)로 붙이고 라우팅 테이블로 경로를 나눕니다. 리전 간 피어링도 됩니다.

PrivateLink는 VPC에서 서비스로 가는 사설 연결입니다. 인터넷 게이트웨이, NAT, 공용 IP, VPN, Direct Connect 없이 인터페이스 엔드포인트로 AWS 서비스나 다른 계정의 엔드포인트 서비스(NLB 뒤)에 접근합니다. VPC 전체를 연결하지 않고 서비스 하나만 노출하니 CIDR이 겹쳐도 쓸 수 있습니다.

| 조건 | 고를 것 |
|---|---|
| VPC 2~3개, 단순 연결 | VPC 피어링 |
| VPC 수십 개와 온프레미스를 허브로 | Transit Gateway |
| 다른 계정의 API 하나만 사설로, CIDR 겹침 | PrivateLink(엔드포인트 서비스) |
| 사설 서브넷에서 S3, DynamoDB로 | 게이트웨이 엔드포인트 |

### 5-5. 로드 밸런싱 전략

ALB, NLB, GWLB의 계층과 고정 IP 차이는 Ch-00 4-2절에 있습니다. 성능 관점에서 덧붙이면 ALB는 경로와 호스트 기반 라우팅으로 마이크로서비스를 나누고 NLB는 고정 IP와 TCP/UDP, 아주 높은 처리량이 필요할 때 씁니다. PrivateLink 엔드포인트 서비스를 만들 때 서비스 쪽 앞단이 NLB라는 점도 5-4절과 이어집니다.

### 5-6. 시험에서 갈리는 조건(네트워크)

| 시나리오 문구 | 고를 것 |
|---|---|
| 전 세계 사용자에게 상품 이미지 전달 지연 감소 | CloudFront |
| 모바일 게임 서버, UDP, 고정 IP 허용 목록 | Global Accelerator |
| 온프레미스와 10Gbps 일관된 대역폭 | Direct Connect |
| VPN 대역폭이 1.25Gbps에 막힘 | Transit Gateway + ECMP로 터널 여러 개 |
| VPC 여러 개가 서로 다 통신, 관리 단순화 | Transit Gateway |
| 협력사에 내부 API 하나만 사설 노출 | PrivateLink |

## 6. 과제 3.5 고성능 데이터 수집과 변환

이 과제는 Ch-00에서 데이터 엔지니어 관점으로 짧게 다뤘고 여기서는 안내서 항목 순서로 넓힙니다. Kafka의 로그와 파티션 구조는 [DE Ch-11](/blog/data/streaming/de-11-kafka-log-partition-group), 테이블 포맷과 레이크하우스는 [DE Ch-18](/blog/data/lakehouse/de-18-iceberg-table-format)과 [DE Ch-20](/blog/data/lakehouse/de-20-cdc-to-lakehouse)에서 더 깊게 정리했습니다.

### 6-1. 수집 빈도로 경로 정하기

안내서 지식 항목 "데이터 수집 패턴(빈도)"은 경로를 고르는 첫 질문입니다.

| 빈도 | 예시 | 경로 |
|---|---|---|
| 하루 한 번 대량 파일 | 온프레미스 NAS의 전날 주문 파일 | DataSync, Transfer Family(SFTP) |
| 분 단위로 모아 넣으면 되는 로그 | 웹 서버 접근 로그를 S3로 | Data Firehose |
| 초 단위, 여러 소비자가 다시 읽음 | 결제 이벤트를 사기 탐지와 정산이 각자 소비 | Kinesis Data Streams 또는 MSK |
| 이미 Kafka 생산자와 소비자가 있음 | 기존 Kafka 이관 | MSK |

### 6-2. Kinesis Data Streams 용량

"Quotas and limits"(Kinesis Data Streams) 문서의 값입니다.

| 항목 | 프로비저닝 모드 | 온디맨드 모드 |
|---|---|---|
| 쓰기 | 샤드당 1MB/s 또는 1,000레코드/s | 새 스트림 기본 4MB/s, 리전에 따라 200MB/s 또는 10GB/s까지 자동 확장 |
| 읽기 | 샤드당 2MB/s(GetRecords), 초당 읽기 트랜잭션 5회 | 새 스트림 기본 8MB/s |
| 확장 | 샤드 수를 직접 조정(UpdateShardCount) | 자동 |
| 보존 기간 | 최소 24시간, 최대 8,760시간(365일) | 같음 |
| 레코드 크기 | base64 인코딩 전 최대 10MiB | 같음 |

향상된 팬아웃(enhanced fan-out) 소비자는 온디맨드 Standard와 프로비저닝 모드에서 스트림당 20개까지 등록하고 2026년 10월 문서의 On-demand Advantage 모드에서는 50개까지 등록합니다. 소비자가 많아 샤드당 읽기 2MB/s를 나눠 쓰느라 느려지면 향상된 팬아웃이 답입니다. "Develop enhanced fan-out consumers with dedicated throughput" 문서(2026년 10월 20일 확인)의 비교는 이렇습니다.

| | 공유 처리량 소비자 | 향상된 팬아웃 소비자 |
|---|---|---|
| 읽기 처리량 | 샤드당 합계 2MB/s를 모든 소비자가 나눠 쓴다 | 소비자마다 샤드당 2MB/s를 따로 받는다 |
| 전파 지연 | 소비자 1개면 평균 약 200ms, 5개면 약 1,000ms | 소비자 수와 관계없이 평균 약 70ms |
| 전달 방식 | `GetRecords`로 당겨 온다(pull) | `SubscribeToShard`로 HTTP/2 푸시 |
| 요금 | 해당 없음 | 데이터 조회 요금과 소비자·샤드 시간 요금 |

파티션 키가 같은 레코드는 같은 샤드로 가서 순서가 지켜집니다. 특정 키에 쓰기가 몰려 `ProvisionedThroughputExceededException`이 나면 파티션 키를 더 고르게 나누거나 샤드를 늘립니다.

### 6-3. Data Firehose: 버퍼링과 형식 변환

Firehose 문서는 Firehose를 S3, Redshift, OpenSearch, Splunk, Iceberg 테이블, HTTP 엔드포인트로 스트리밍 데이터를 전달하는 완전 관리형 서비스로 설명합니다. 애플리케이션을 만들거나 자원을 관리할 필요가 없습니다.

버퍼링 값은 API 참조 "BufferingHints" 기준입니다. 버퍼 간격은 0~900초(기본 300초), 버퍼 크기는 1~128MiB(기본 5MiB)이고 둘 중 먼저 차는 쪽에서 전달합니다. 문서는 버퍼 크기를 보통 10초 동안 들어오는 양보다 크게 잡으라고 권합니다. 0초 간격은 지연이 낮은 실시간 용도를 위한 값이고 60초 미만이면 S3 전달에 멀티파트 업로드를 써서 PUT 요청 비용이 늘 수 있습니다. 이 마지막 두 문장은 Firehose 개발자 가이드의 버퍼링 페이지 검색 요약으로 확인했고 페이지 본문은 직접 열지 못했습니다.

형식 변환("Convert input data format in Amazon Data Firehose")의 조건은 세 가지입니다.

1. 입력은 JSON이어야 합니다. CSV 같은 다른 형식은 Lambda로 먼저 JSON으로 바꿉니다.
2. 스키마는 Glue Data Catalog에 있어야 합니다.
3. 직렬화 형식으로 Parquet이나 ORC를 고릅니다.

"Firehose가 CSV를 Parquet으로 바로 바꾼다"는 보기는 Lambda 변환 단계가 빠져 있으면 틀린 설명입니다.

### 6-4. MSK

MSK 문서는 MSK를 오픈 소스 Apache Kafka를 그대로 돌리는 완전 관리형 서비스로 설명합니다. 기존 애플리케이션과 도구를 코드 변경 없이 쓸 수 있습니다. 브로커는 AZ마다 지정하고 Provisioned(Standard, Express 브로커)와 Serverless가 있습니다. Kinesis FAQ가 "이미 Kafka를 쓰면 MSK"를 권한다는 점은 Ch-00에서 정리했습니다. Kinesis와 Kafka 모두 파티션(샤드) 안에서만 순서를 지킨다는 공통점은 DE Ch-11에서 다뤘습니다.

### 6-5. 데이터 전송 서비스

| 서비스 | 하는 일 | 고르는 조건 |
|---|---|---|
| DataSync | NFS, SMB, HDFS, 객체 스토리지와 S3, EFS, FSx 사이 온라인 전송. 암호화와 무결성 검증 포함 | 대량 파일 이관, 반복 동기화, 콜드 데이터를 Glacier로 |
| Storage Gateway | 온프레미스 앱이 계속 파일, 볼륨, 테이프 인터페이스로 클라우드 저장소를 씀 | 이관 후에도 온프레미스 접근이 계속 필요 |
| Transfer Family | SFTP, FTPS, FTP, AS2, 브라우저 전송을 S3나 EFS로 | 협력사가 SFTP로 파일을 보냄, 클라이언트 설정을 바꾸지 않음 |
| Snowball | 오프라인 기기로 대량 데이터 이동 | 네트워크가 제한된 환경. 상용 리전 지원은 2026년 12월 31일에 끝난다는 공지가 있다 |

DataSync 문서는 VPC 엔드포인트로 공용 인터넷을 거치지 않고 전송할 수 있다고 적습니다. 안내서 지식 항목 "수집 접근 지점에 대한 안전한 접근"에 해당합니다. Snowball 지원 종료 공지는 2026년 10월 AWS Snowball 제품 페이지에서 확인했습니다. 시험 문항에 Snowball이 아직 정답으로 나오는지는 확인할 방법이 없습니다.

### 6-6. 변환과 처리: Glue, EMR, Athena

| | Glue | EMR | Athena |
|---|---|---|---|
| 형태 | 서버리스 데이터 통합 | 관리형 클러스터(Hadoop, Spark 등) | 서버리스 SQL 쿼리 |
| 주 용도 | 크롤러로 스키마 추론, Data Catalog, Spark 기반 ETL | 대규모 처리, 프레임워크와 설정을 직접 고름 | S3 데이터를 바로 SQL로 조회 |
| 고르는 문구 | "서버리스 ETL", "스키마 자동 발견" | "기존 Spark/Hadoop 작업", "클러스터 설정 제어" | "임시 쿼리", "서버 없이 SQL" |

안내서 기술 항목 "데이터 처리용 컴퓨팅 선택(예: EMR)"은 이 표의 가운데 열입니다. 같은 Spark 작업이라도 운영 부담을 줄이는 쪽은 Glue이고 버전, 노드 유형, 오픈 소스 구성 요소를 직접 골라야 하면 EMR입니다.

### 6-7. 데이터 레이크 구축과 보안: Lake Formation

Lake Formation 문서는 IAM 권한 모델을 보완하는 자체 권한 모델을 제공한다고 적습니다. 관계형 DB처럼 부여(grant)와 회수(revoke)로 관리하고 데이터베이스, 테이블, 열, 행, 셀 단위 통제를 Athena, Amazon Quick, Redshift Spectrum, EMR, Glue에 적용합니다. LF-Tag로 수많은 리소스의 권한을 태그 몇 개로 대신 관리하는 태그 기반 접근 제어도 있습니다. CloudTrail로 누가 어떤 서비스로 어떤 데이터에 접근했는지 감사합니다.

"분석가 그룹에게 고객 테이블의 개인 정보 열만 가리고 보여 준다", "다른 계정에 테이블 일부를 공유한다"가 Lake Formation 문구입니다. 버킷 정책이나 IAM 정책만으로 열 단위 통제를 하려는 보기는 운영 부담이 큰 쪽입니다.

### 6-8. CSV를 Parquet으로: 세 가지 경로

안내서 기술 항목에 "형식 변환(예: .csv를 .parquet으로)"이 그대로 있습니다. 경로는 세 가지를 알아 둡니다.

| 경로 | 조건 |
|---|---|
| Firehose 형식 변환 | 스트리밍 입력. JSON 입력이 필요하니 CSV는 Lambda로 JSON 변환 후 Glue 스키마로 Parquet |
| Glue ETL 작업 | S3에 쌓인 CSV를 배치로 변환. 크롤러로 스키마를 만든 뒤 작업 실행 |
| Athena CTAS | 이미 테이블로 등록된 CSV를 `CREATE TABLE AS SELECT`로 Parquet 테이블 생성 |

Athena 문서("Optimize data")가 Parquet 같은 컬럼 형식을 권하는 이유는 세 가지입니다. 쿼리에 필요한 열만 읽습니다. 같은 열 값이 모여 있어 압축이 잘 됩니다. 파일 메타데이터의 최솟값과 최댓값으로 필요 없는 부분을 건너뜁니다. 같은 문서의 성능 조언을 몇 가지 덧붙입니다.

- 가장 흔한 쿼리에 맞춰 파티션 키를 고릅니다. 파티션이 너무 많으면 작은 파일이 쏟아집니다.
- 작은 파일이 많으면 계획과 요청 비용이 커지고 S3의 503 Slow Down까지 갈 수 있습니다. 쓰는 쪽에서 버퍼를 늘려 큰 파일로 씁니다.
- Parquet 행 그룹 기본 크기는 128MB이고 더 작게 줄이는 것은 권하지 않습니다.
- 파티션 수가 많으면 파티션 프로젝션이 카탈로그 조회 대신 메모리에서 계산해 빨라질 수 있습니다.

### 6-9. 시각화

안내서는 시각화 서비스 예로 Amazon Quick을 적습니다. Lake Formation과 CUR 문서도 같은 이름을 씁니다. 이전 이름 QuickSight와 어떤 관계인지는 이번에 공식 문서로 확인하지 못했습니다. 시험에서는 "S3와 Athena의 결과를 대시보드로 공유"가 이 서비스의 문구로 보입니다.

### 6-10. 시험에서 갈리는 조건(데이터)

| 시나리오 문구 | 고를 것 |
|---|---|
| 클릭 로그를 거의 실시간으로 여러 앱이 소비, 재처리 | Kinesis Data Streams |
| 로그를 S3에 Parquet으로 쌓고 Athena로 조회, 관리 최소 | Data Firehose(형식 변환) + Glue Data Catalog |
| 기존 Kafka 클러스터 이관 | MSK |
| 온프레미스 NFS 수백 TB를 S3로 온라인 이관 | DataSync |
| 협력사가 SFTP로 매일 파일 업로드 | Transfer Family |
| 열 단위 권한, 계정 간 공유 | Lake Formation |
| 기존 Spark 작업, 클러스터 설정 직접 제어 | EMR |
| S3의 CSV를 서버 없이 한 번 변환 | Athena CTAS 또는 Glue ETL |

## 7. 확인 문제

아래 문제는 공식 문서의 조건을 바탕으로 직접 만든 연습 문제입니다. 실제 시험 문항이나 문제 은행에서 가져오지 않았습니다.

**문제 1.** 사진 공유 서비스가 업로드 원본을 S3 버킷 하나에 `uploads/` 접두사로 저장합니다. 이벤트 기간에 초당 업로드가 6,000건까지 늘었고 503 Slow Down 응답이 늘었습니다. 애플리케이션 코드를 조금 바꿔서 해결하려면?

A. 버킷을 S3 One Zone-IA로 바꾼다
B. 객체 키에 사용자 ID 해시로 접두사를 나눠 여러 접두사에 쓴다
C. S3 Transfer Acceleration을 켠다
D. 버킷 앞에 CloudFront를 둔다

<details>
<summary>정답과 해설</summary>

B입니다. 쓰기 한도는 분할된 접두사당 초당 최소 3,500건이고 접두사 수에는 제한이 없습니다. 접두사를 나누면 쓰기가 병렬로 확장됩니다. A는 저장 비용을 바꿀 뿐 요청 한도와 관계가 없습니다. C는 먼 거리 전송 지연을 줄이는 기능입니다. D의 CloudFront는 읽기 캐시라서 쓰기 병목을 풀지 못합니다.
</details>

**문제 2.** 게시판 서비스의 RDS for PostgreSQL에서 관리자 통계 화면이 무거운 집계 쿼리를 돌려 사용자 게시글 조회가 느려집니다. 통계는 몇 분 늦어도 괜찮습니다. 가장 적절한 조치는?

A. Multi-AZ를 켜고 대기 인스턴스로 통계 쿼리를 보낸다
B. 읽기 복제본을 만들고 통계 화면만 복제본 엔드포인트로 연결한다
C. 인스턴스 스토리지를 io2 Block Express로 바꾼다
D. RDS Proxy를 앞에 둔다

<details>
<summary>정답과 해설</summary>

B입니다. 읽기 복제본은 비동기라 약간 늦을 수 있고 문제의 조건(몇 분 늦어도 됨)이 그것을 허용합니다. 문서가 드는 용도에도 보고 쿼리를 복제본으로 돌리는 경우가 있습니다. A의 Multi-AZ 대기 인스턴스는 읽기를 처리하지 않습니다. C는 I/O를 늘리지만 같은 인스턴스에서 경합은 그대로입니다. D는 연결 관리 도구이고 읽기 복제본에는 붙일 수도 없습니다.
</details>

**문제 3.** 결제 알림을 처리하는 Lambda 함수 수천 개가 동시에 실행될 때 RDS for MySQL 연결 수가 한도에 걸려 오류가 납니다. 코드 변경을 최소로 하려면?

A. DB 인스턴스 클래스를 두 단계 올린다
B. RDS Proxy를 만들고 함수가 프록시 엔드포인트로 연결하게 한다
C. 읽기 복제본 5개를 만들어 연결을 나눈다
D. Lambda 메모리를 10,240MB로 올린다

<details>
<summary>정답과 해설</summary>

B입니다. RDS Proxy는 연결 풀을 만들어 재사용하고 즉시 처리할 수 없는 연결은 대기시키거나 조절합니다. 문서는 대부분의 애플리케이션이 코드 변경 없이 쓸 수 있다고 적습니다. A는 `max_connections`가 메모리에 비례해 늘긴 하지만 비용이 크고 폭주가 더 커지면 다시 막힙니다. C는 결제 알림 처리가 쓰기라면 도움이 안 됩니다. D는 연결 수와 관계가 없습니다.
</details>

**문제 4.** 쇼핑몰의 DynamoDB 상품 테이블에서 특가 상품 몇 개에 읽기가 몰립니다. 응답은 마이크로초 단위여야 하고 가격이 몇 초 늦게 반영되는 것은 괜찮습니다. 무엇을 고르나요?

A. DynamoDB Accelerator(DAX)
B. 테이블을 프로비저닝 모드로 바꾸고 RCU를 크게 잡는다
C. 강한 일관성 읽기로 바꾼다
D. ElastiCache for Memcached를 두고 앱 코드에 캐시 로직을 새로 쓴다

<details>
<summary>정답과 해설</summary>

A입니다. DAX는 최종 일관성 읽기의 응답을 마이크로초로 줄이고 API가 DynamoDB와 호환돼 코드 변경이 적습니다. 문서가 드는 예시도 하루 특가 상품에 읽기가 몰리는 경우입니다. B는 처리량은 늘지만 지연이 한 자리 밀리초 수준에 머뭅니다. C는 오히려 DAX와 맞지 않는 조건입니다. D도 가능은 하지만 캐시 로직을 직접 써야 해서 A보다 운영 부담이 큽니다.
</details>

**문제 5.** 온라인 강의 서비스가 실시간 퀴즈 서버를 두 리전에 운영합니다. 클라이언트는 UDP로 접속하고 학교 방화벽 때문에 접속 IP를 고정 목록으로 등록해야 합니다. 한 리전이 실패하면 1분 안에 다른 리전으로 넘어가야 합니다.

A. CloudFront 배포와 오리진 그룹
B. Route 53 지연 시간 기반 라우팅
C. AWS Global Accelerator
D. 리전마다 NLB에 탄력적 IP를 붙이고 사용자에게 두 IP를 모두 알려 준다

<details>
<summary>정답과 해설</summary>

C입니다. Global Accelerator는 고정 애니캐스트 IPv4 주소 2개를 주고 TCP와 UDP를 지원합니다. FAQ는 비정상 엔드포인트를 1분 안에 제외한다고 적습니다. A의 CloudFront는 HTTP 콘텐츠용입니다. B는 DNS라서 고정 IP 조건을 만족하지 못하고 클라이언트의 DNS 캐시 때문에 전환이 늦을 수 있습니다. D는 클라이언트가 장애 조치를 직접 해야 합니다.
</details>

**문제 6.** 웹 서버 접근 로그를 S3에 Parquet으로 저장해 Athena로 조회하려 합니다. 로그는 CSV 한 줄 형식으로 들어오고 운영 부담은 가장 적어야 합니다. 맞는 구성은?

A. Firehose에서 형식 변환만 켠다
B. Firehose에서 Lambda 변환으로 CSV를 JSON으로 바꾸고 Glue Data Catalog 스키마로 Parquet 변환을 켠다
C. Kinesis Data Streams에 넣고 EC2 소비자가 Parquet 파일을 쓴다
D. 원본 CSV를 S3에 그대로 두고 Athena로 조회한다

<details>
<summary>정답과 해설</summary>

B입니다. Firehose 형식 변환은 JSON 입력만 받고 스키마는 Glue Data Catalog에서 가져옵니다. CSV는 Lambda로 먼저 JSON으로 바꿔야 합니다. A는 CSV 입력이라 변환이 실패합니다. C는 소비자를 직접 운영해야 합니다. D도 조회는 되지만 Athena는 스캔한 바이트로 요금을 매기고 열 단위로 건너뛰는 이점이 없어 Parquet 요구를 만족하지 못합니다.
</details>

**문제 7.** 분석 작업이 정렬 중간 파일을 대량으로 쓰고 읽습니다. 작업이 끝나면 중간 파일은 필요 없고 작업이 실패하면 처음부터 다시 돌리면 됩니다. I/O 지연이 가장 낮은 저장소는?

A. gp3 볼륨에 IOPS를 최대로 프로비저닝
B. EFS Elastic 처리량
C. 인스턴스 스토어가 있는 인스턴스 유형(예: 이름에 `d`가 붙은 유형)
D. S3 Express One Zone

<details>
<summary>정답과 해설</summary>

C입니다. 인스턴스 스토어는 호스트에 물리적으로 붙은 디스크라 네트워크 볼륨보다 지연이 낮고 추가 요금도 없습니다. 중지하면 데이터가 지워지지만 이 문제는 중간 파일을 잃어도 되는 조건입니다. A와 B는 네트워크를 거칩니다. D는 한 자리 밀리초 객체 저장소라서 블록 수준 정렬 스크래치로는 C보다 지연이 큽니다.
</details>

**문제 8.** 회사에 VPC가 25개 있고 앞으로 늘어납니다. 모든 VPC가 온프레미스 데이터센터와 통신해야 하고 VPC끼리도 일부 통신해야 합니다. 네트워크 관리 부담이 가장 적은 구성은?

A. VPC끼리 모두 피어링하고 VPC마다 Site-to-Site VPN을 만든다
B. Transit Gateway에 VPC와 VPN(또는 Direct Connect 게이트웨이)을 붙이고 라우팅 테이블로 통신 범위를 나눈다
C. 허브 VPC 하나에 VPN을 두고 나머지 VPC를 허브와 피어링한다
D. 모든 서비스를 PrivateLink 엔드포인트 서비스로 노출한다

<details>
<summary>정답과 해설</summary>

B입니다. Transit Gateway는 VPC와 온프레미스를 잇는 허브이고 연결별 라우팅 테이블로 범위를 나눕니다. A는 연결 수가 VPC 수의 제곱으로 늘어납니다. C는 피어링이 전이 라우팅과 엣지 투 엣지 라우팅을 지원하지 않아 허브 VPC의 VPN을 다른 VPC가 쓸 수 없습니다. D는 서비스 단위 노출이라 VPC 사이 일반 통신과 온프레미스 연결을 대신하지 못합니다.
</details>

## 8. 범위와 한계

- 수치와 제약은 2026년 10월 19일에 연 AWS 공식 문서 기준입니다. gp3 최대값처럼 최근에 바뀐 값이 있어서 강의 자료와 다를 수 있고 시험 문항이 언제 기준인지는 알 수 없습니다.
- 이 글의 서비스들을 직접 만들어 측정하지 않았습니다. 성능 수치는 모두 문서가 밝힌 설계 값이거나 최대값이고 제가 잰 값이 없습니다. Ch-00 계획의 실습 단계를 마친 뒤 측정한 내용을 따로 쓰겠습니다.
- 확인하지 못한 것: Firehose 버퍼링 페이지 본문(검색 요약으로만 확인), Amazon Quick과 QuickSight의 관계, MySQL과 PostgreSQL을 비교한 공식 표. ElastiCache의 지연 로딩과 라이트 스루 정의는 Ch-02 2-11절에서 ElastiCache 문서로 정리했습니다.
- 2026년 10월 20일 보강: 향상된 팬아웃의 소비자당 샤드 2MB/s와 평균 약 70ms 전파 지연, Transfer Acceleration 조건, Aurora Global Database 보조 리전 수(엔진 공통 10개), S3 Express One Zone 요청 비용 문구가 페이지마다 다른 점을 확인해 넣었습니다.
- FSx File Gateway 신규 제공 중단과 Snowball 지원 종료(2026년 12월 31일) 공지는 확인했지만 시험 출제 범위에 반영됐는지는 모릅니다. Kinesis On-demand Advantage 모드도 시험 안내서 이후에 생긴 것으로 보입니다.
- 확인 문제는 직접 만든 것이라 실제 시험의 난이도나 문구와 다를 수 있습니다.

## 참고 자료

시험 안내서
- AWS, [Content Domain 3: Design High-Performing Architectures](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03-domain3.html)
- AWS, [AWS Certified Solutions Architect - Associate (SAA-C03)](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html)

스토리지
- [Best practices design patterns: optimizing Amazon S3 performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html), [Performance guidelines for Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html), [High performance workloads (S3 Express One Zone)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-high-performance.html), [Understanding and managing Amazon S3 storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html), [Configuring fast, secure file transfers using Amazon S3 Transfer Acceleration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/transfer-acceleration.html)
- [Using Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)
- [Amazon EBS volume types](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html), [Amazon EBS General Purpose SSD volumes](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html)
- [Instance store temporary block storage for EC2 instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/InstanceStorage.html), [Data persistence for Amazon EC2 instance store volumes](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-lifetime.html)
- [Amazon EFS performance specifications](https://docs.aws.amazon.com/efs/latest/ug/performance.html)
- [Help Me Choose An Amazon FSx File System](https://aws.amazon.com/fsx/when-to-choose-fsx/)
- [AWS Storage Gateway Documentation](https://docs.aws.amazon.com/storagegateway/latest/userguide/WhatIsStorageGateway.html), [What is Volume Gateway?](https://docs.aws.amazon.com/storagegateway/latest/vgw/WhatIsStorageGateway.html), [What is Amazon FSx File Gateway](https://docs.aws.amazon.com/filegateway/latest/filefsxw/what-is-file-fsxw.html)

컴퓨팅
- [Amazon EC2 instance type naming conventions](https://docs.aws.amazon.com/ec2/latest/instancetypes/instance-type-names.html)
- [Placement strategies for your placement groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/placement-strategies.html)
- [Dynamic scaling for Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scale-based-on-demand.html)
- [Configure Lambda Event Function memory](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html), [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [Architect for AWS Fargate for Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html), [What is AWS Batch?](https://docs.aws.amazon.com/batch/latest/userguide/what-is-batch.html), [What is Amazon EMR?](https://docs.aws.amazon.com/emr/latest/ManagementGuide/emr-what-is-emr.html)

데이터베이스
- [Working with DB instance read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html), [Differences between read replicas for DB engines](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.Overview.Differences.html), [Quotas and constraints for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html)
- [Amazon Aurora storage](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.StorageReliability.html), [Replication with Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html), [How Aurora serverless works](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.how-it-works.html)
- [Amazon RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- [DynamoDB throughput capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/capacity-mode.html), [In-memory acceleration with DynamoDB Accelerator (DAX)](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DAX.html)
- [Comparing node-based Valkey, Memcached, and Redis OSS clusters](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/SelectEngine.html)
- [What is AWS Database Migration Service?](https://docs.aws.amazon.com/dms/latest/userguide/Welcome.html)

네트워크
- [What is Amazon CloudFront?](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html), [AWS Global Accelerator FAQs](https://aws.amazon.com/global-accelerator/faqs/)
- [AWS Site-to-Site VPN quotas](https://docs.aws.amazon.com/vpn/latest/s2svpn/vpn-limits.html), [Direct Connect dedicated and hosted connections](https://docs.aws.amazon.com/directconnect/latest/UserGuide/WorkingWithConnections.html), [Dedicated Direct Connect connections](https://docs.aws.amazon.com/directconnect/latest/UserGuide/dedicated_connection.html)
- [How VPC peering connections work](https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-basics.html), [What is AWS Transit Gateway for Amazon VPC?](https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html), [What is AWS PrivateLink?](https://docs.aws.amazon.com/vpc/latest/privatelink/what-is-privatelink.html)

데이터 수집과 변환
- [Quotas and limits (Kinesis Data Streams)](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html), [Develop enhanced fan-out consumers with dedicated throughput](https://docs.aws.amazon.com/streams/latest/dev/enhanced-consumers.html)
- [What is Amazon Data Firehose?](https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html), [Convert input data format in Amazon Data Firehose](https://docs.aws.amazon.com/firehose/latest/dev/record-format-conversion.html), [BufferingHints](https://docs.aws.amazon.com/firehose/latest/APIReference/API_BufferingHints.html)
- [Welcome to the Amazon MSK Developer Guide](https://docs.aws.amazon.com/msk/latest/developerguide/what-is-msk.html)
- [What is AWS DataSync?](https://docs.aws.amazon.com/datasync/latest/userguide/what-is-datasync.html), [What is AWS Transfer Family?](https://docs.aws.amazon.com/transfer/latest/userguide/what-is-aws-transfer-family.html), [AWS Snowball](https://aws.amazon.com/snowball/)
- [What is AWS Glue?](https://docs.aws.amazon.com/glue/latest/dg/what-is-glue.html), [What is AWS Lake Formation?](https://docs.aws.amazon.com/lake-formation/latest/dg/what-is-lake-formation.html)
- [Optimize Athena performance](https://docs.aws.amazon.com/athena/latest/ug/performance-tuning.html), [Optimize data (Athena)](https://docs.aws.amazon.com/athena/latest/ug/performance-tuning-data-optimization-techniques.html)
