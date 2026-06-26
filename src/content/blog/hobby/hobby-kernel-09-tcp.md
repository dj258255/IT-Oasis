---
title: 'TCP — 신뢰성은 번호 매기기에서 온다'
titleEn: 'TCP — Reliability Comes from Numbering'
description: UDP는 패킷을 던지고 잊는다. TCP는 "내가 어디까지 보냈고 어디까지 받았나"를 시퀀스 번호로 추적해, 순서와 도착을 보장한다. net 스택 위에 TCP 세그먼트와 3-way 핸드셰이크를 올려, 수동 개방 서버를 만든다. 호스트가 접속해 보낸 데이터를 게스트 커널이 받아 에코하고, 그 왕복으로 핸드셰이크부터 종료까지를 검증한다. 그리고 우리가 일부러 빼놓은 것 — 재전송, 혼잡 제어, 윈도우 — 의 트레이드오프까지.
descriptionEn: "UDP fires and forgets. TCP tracks 'how far I've sent and how far I've received' with sequence numbers, guaranteeing order and delivery. On top of the net stack we add TCP segments and the 3-way handshake to build a passive-open server. A host connects and sends data, the guest kernel receives and echoes it, and that round-trip verifies everything from handshake to close. Plus the trade-offs of what we deliberately left out — retransmission, congestion control, windows."
date: 2026-06-18T00:00:00.000Z
tags:
  - OS
  - C
  - Kernel
  - RISC-V
  - xv6
  - QEMU
  - Network
  - TCP
category: project/hobby-kernel
coverImage: "/uploads/hobby/hobby-kernel-c/cover.svg"
draft: false
series: "C로 만드는 토이 커널"
seriesOrder: 10
---


*바닥부터 직접 만드는 RISC-V 토이 커널 연재. 이 글은 10편 — UDP까지 올린 [네트워크 스택](/blog/hobby/hobby-kernel-06-networking) 위에 **최소 TCP**(3-way 핸드셰이크 + seq/ack 회계)를 얹습니다.*

## 0. 들어가며

[7편에서 만든 네트워크 스택](/blog/hobby/hobby-kernel-06-networking)은 UDP까지였어요.
UDP는 단순합니다 — 패킷 하나를 만들어 던지면 끝이에요.
도착했는지, 순서가 맞는지 신경 쓰지 않아요. **던지고 잊어버립니다(fire and forget).**

TCP는 다른 약속을 해요.
"보낸 바이트는 빠짐없이, 보낸 순서대로 — 애플리케이션에게 — 전달된다." (패킷 자체는 뒤바뀌거나 중복돼 도착할 수 있고, TCP가 내부에서 재정렬해 *앱에는* 순서대로 보이게 하는 거예요.)
그런데 우리가 쓰는 네트워크 계층(IP)은 그런 약속을 전혀 하지 않아요 — 패킷은 사라질 수도, 뒤바뀔 수도, 복제될 수도 있습니다.
TCP는 **그 못 믿을 바닥 위에 믿을 수 있는 바이트 스트림을 세우는** 프로토콜이에요.

이 글의 핵심 질문은 하나예요 — **그 신뢰성은 도대체 어디서 오는가.**
답은 마법이 아니라 **번호 매기기**입니다.
이번 글은 그 번호 매기기(시퀀스 번호와 ACK)로 TCP의 심장인 **3-way 핸드셰이크**를 구현하고, **수동 개방(서버)** 을 만들어 호스트와 실제로 데이터를 주고받아요.
그리고 우리가 **일부러 빼놓은 것**(재전송·혼잡 제어·윈도우)까지 정직하게 짚습니다.

> 왜 TCP를 직접 짜보나: UDP는 한 글이면 끝나는데, TCP는 "신뢰성"이라는 한 단어 안에 시퀀스 회계·핸드셰이크·체크섬·상태 전이가 전부 들어 있어요. 그걸 손으로 한 번 만들어 보면 "TCP가 비싼 이유"가 추상적인 지식이 아니라 코드의 무게로 손에 잡힙니다.

## 1. TCP가 풀어야 하는 진짜 문제

> UDP로 "1, 2, 3"이라는 세 패킷을 보냈습니다. 받는 쪽이 "1, 3"만 받았거나 "2, 1, 3" 순서로 받았다면, 받는 쪽은 그 사실을 **알 수조차 없습니다.** 어떻게 해야 "빠진 게 있다", "순서가 틀렸다"를 알아챌까요?

UDP의 한계를 구체적으로 보면 이래요.

```
보낸 쪽:  [seg 1] [seg 2] [seg 3]
                   ↓ 네트워크(IP)는 아무것도 보장 안 함
받은 쪽:  [seg 1] [seg 3]            ← seg 2가 사라졌는데, 받은 쪽은 모름
받은 쪽:  [seg 2] [seg 1] [seg 3]    ← 순서가 뒤바뀌었는데, 받은 쪽은 모름
```

UDP 헤더에는 **포트와 길이와 체크섬**밖에 없어요.
"이게 몇 번째 패킷인지"를 적는 칸이 없으니, 받는 쪽은 빠짐도 뒤바뀜도 감지할 도리가 없습니다.
이게 *"던지고 잊기"* 의 진짜 의미예요 — 보낸 쪽도 받았는지 모르고, 받은 쪽도 다 받았는지 몰라요.

그래서 TCP가 풀어야 하는 문제는 세 가지로 압축됩니다.

1. **도착 보장**: 보낸 게 사라지면 어떻게 알고 다시 보낼까?
2. **순서 보장**: 뒤바뀐 채 도착하면 어떻게 원래 순서로 되돌릴까?
3. **연결의 시작과 끝**: "지금부터 대화 시작", "이제 끝"을 양쪽이 어떻게 합의할까?

세 문제의 공통 해법이 바로 **"모든 바이트에 번호를 매긴다"** 예요.
번호가 있으면 *"몇 번까지 받았다"* 를 말할 수 있고(도착 확인), *"빠진 번호가 있다"* 를 알 수 있고(재전송 트리거), *"번호 순서대로 재배열"* 할 수 있어요(재정렬).
이 글에서 우리가 직접 구현하는 건 1·3번의 **씨앗**이고(도착 확인과 연결 합의), 2번과 본격적인 1번(재전송·재정렬), 그리고 TCP의 또 다른 핵심인 **흐름 제어(윈도우)** 는 5절에서 *"왜 일부러 뺐는지"* 로 다룹니다.

## 2. 사전 지식 — 시퀀스 번호 회계라는 양방향 장부

TCP의 신뢰성은 양쪽이 각자 쥐고 있는 **장부(ledger)** 두 칸에서 나와요.

### seq와 ack — 두 숫자가 하는 일

> 한 연결에서 데이터는 양방향으로 흐릅니다. 그런데 "내가 보낸 것"과 "내가 받은 것"은 완전히 다른 숫자예요. 이 둘을 어떻게 동시에 추적할까요?

- **seq**(시퀀스 번호): *"내가 지금 보내는 이 바이트는 내 스트림의 몇 번째다."*
- **ack**(확인 응답 번호): *"나는 상대 스트림을 여기까지 받았다. 다음은 이 번호부터 보내라."*

핵심은 seq와 ack가 **서로 다른 두 스트림을 가리킨다**는 거예요.
내 seq는 *"내가 보내는 흐름"* 의 위치고, 내 ack는 *"상대가 보내는 흐름"* 에서 내가 받은 위치예요.
그래서 양쪽이 각각 `(내 seq, 내 ack)` 한 쌍을 들고 있으면, 연결 전체의 진행 상황이 두 쌍으로 완전히 기술됩니다.

실제 우리 코드에서도 이 장부가 그대로 변수로 등장해요.

```c
// net_tcp_demo() — 서버가 들고 있는 장부
uint32 myseq = 20000;          // "내가 보내는 흐름"의 현재 위치 (우리 ISN)
uint32 cliseq;                 // 상대(클라이언트)가 보낸 seq
uint32 cliack = cliseq + 1;    // "상대에게서 다음에 기대하는 seq" = 내 ack
```

`tcp_recv`가 세그먼트를 받을 때마다 상대의 seq/ack/flags를 뽑아 이 장부를 갱신하고, `tcp_send`로 답할 때 내 seq와 (상대에게서 받은 위치를 적은) ack를 실어 보내요.

### 흔한 오해 — "SYN/FIN은 데이터가 없으니 번호를 안 쓴다"?

> **흔한 오해 정정**: SYN과 FIN은 페이로드(데이터)가 0바이트예요. 그래서 *"빈 패킷이니 시퀀스 번호를 소비하지 않겠지"* 라고 생각하기 쉬운데, **정반대**입니다. **SYN과 FIN은 데이터가 없어도 시퀀스 번호를 정확히 1 소비해요.** 연결의 *"시작"* 과 *"끝"* 도 스트림 위의 한 지점으로 세는 거죠. 이게 없으면 "내 SYN이 도착했나?"를 확인할 방법이 없어요 — 확인은 ack로 하는데, ack는 *"번호"* 를 가리키니까 SYN도 번호를 하나 차지해야 합니다.

이 규칙이 코드에 그대로 박혀 있어요.

```c
// SYN-ACK를 보낸 뒤, 우리 seq를 1 올린다 (SYN이 seq 1을 소비)
tcp_send(pmac, pip, myport, pport, myseq, cliseq + 1, TH_SYN | TH_ACK, 0, 0);
myseq += 1;                    // ← SYN 플래그가 seq 1 소비 (RFC: "SYN occupies one sequence number")
```

```c
// 데이터 n바이트를 에코한 뒤에는 그 길이만큼 올린다
tcp_send(..., myseq, cliack, TH_PSH | TH_ACK, buf, n);
myseq += n;                    // ← 데이터는 바이트 수만큼 소비
```

SYN은 `+1`, 데이터는 `+n`, FIN도 `+1`.
**"몇 바이트(또는 몇 개의 제어 플래그)를 보냈으면 그만큼 seq를 전진시킨다"** — 이 한 줄 규칙이 TCP 회계의 전부예요.

### UDP vs TCP — 신뢰성을 만드는 요소

| 구분 | UDP | TCP |
|------|-----|-----|
| 전송 모델 | 패킷(datagram) | 바이트 스트림 |
| 헤더에 번호 | 없음 | seq(보낸 위치) + ack(받은 위치) |
| 도착 보장 | 없음 (던지고 잊기) | ack로 확인, 안 오면 재전송 |
| 순서 보장 | 없음 | seq로 재정렬 |
| 연결 | 없음 (상태 없음) | 3-way 핸드셰이크로 수립 |
| 헤더 크기 | 8바이트 | 최소 20바이트 |
| 우리 구현 범위 | 7편에서 완성 | seq/ack 회계 + 핸드셰이크 + 에코(이 글) |

> **핵심 교훈**: UDP와 TCP의 모든 차이는 결국 **"헤더에 번호를 적느냐"** 한 가지에서 파생돼요. 번호가 있으니 확인(ack)이 가능하고, 번호와 ack가 있으니 (타이머와 함께) 재전송을 **구현할 수 있고**, 번호가 있으니 재정렬이 가능합니다. (번호만으로 재전송이 되는 건 아니에요 — 언제 잃었는지는 ACK·타이머가 알려주죠. 이 글은 그 토대까지만.) **신뢰성은 번호 매기기에서 옵니다.**

## 3. 3-way 핸드셰이크 — 왜 하필 세 번인가

연결은 세 번의 인사로 시작해요.

![TCP 3-way 핸드셰이크: 클라이언트 SYN(seq=x) → 서버 SYN-ACK(seq=y, ack=x+1) → 클라이언트 ACK(ack=y+1) → 연결 수립(ESTABLISHED)](/uploads/hobby/hobby-kernel-c/tcp-handshake.svg)

### 왜 두 번도 네 번도 아닌 세 번인가

> 한 번이면 부족하고 두 번이면 안 되고, 그렇다고 네 번은 낭비예요. 정확히 세 번이 필요한 이유는 무엇일까요?

핵심은 **각자의 시작 번호(ISN, Initial Sequence Number)를 상대에게 알리고, 상대가 받았음을 확인받아야** 한다는 거예요.
연결은 양방향이니 **두 개의 스트림**이 있고, 각 스트림마다 *"내 시작 번호를 너에게 알린다 → 네가 확인한다"* 가 필요해요.

- 클라이언트의 ISN(`x`): 1번 메시지(SYN)로 알리고, 2번 메시지(SYN-ACK의 `ack=x+1`)로 확인됨
- 서버의 ISN(`y`): 2번 메시지(SYN-ACK)로 알리고, 3번 메시지(ACK의 `ack=y+1`)로 확인됨

즉 *"알림+확인"* 쌍이 두 개 필요한데, 가운데 2번 메시지가 **서버의 SYN과 클라이언트 SYN에 대한 ACK를 한 번에 겸하기 때문에** 네 번이 세 번으로 줄어요.
그래서 최소가 정확히 **세 번**입니다.

> 한 걸음 더 — RFC가 드는 더 근본적인 이유는 **"오래된 중복 SYN"을 걸러내는 것**이에요([RFC 9293](https://datatracker.ietf.org/doc/html/rfc9293)). 옛 연결의 SYN이 네트워크에 뒤늦게 떠돌다 도착할 수 있는데, 3-way로 ISN을 주고받으면 *상대가 확인(ACK)하지 못하는* 유령 SYN은 자연히 무시돼요. 그래서 3-way는 "ISN 동기화"인 동시에 **"오래된 중복 패킷 방어"** 이기도 합니다. 이 글의 "알림+확인" 프레이밍은 그 동기화 측면을 보는 거예요.

> **흔한 오해 정정**: *"핸드셰이크는 연결을 '여는' 의식일 뿐, 데이터 전송과는 별개"* 라고 생각하기 쉬운데, 핸드셰이크 자체가 이미 **시퀀스 회계의 시작**이에요. SYN이 ISN을 싣고, 그 ISN이 seq 1을 소비하고, 상대가 `ISN+1`로 ack를 답하는 — 2절에서 본 회계가 핸드셰이크에서 그대로 작동합니다. 핸드셰이크는 "회계 장부의 첫 줄"을 양쪽이 맞추는 일이에요.

### 우리는 수동 개방(서버)을 구현했다

TCP 연결은 두 방식으로 열려요.

- **능동 개방(active open)**: 내가 먼저 SYN을 보내 연결을 거는 쪽 — 보통 **클라이언트**
- **수동 개방(passive open)**: 포트를 열어두고 누가 SYN을 보내오길 **기다리는** 쪽 — 보통 **서버**

우리는 **수동 개방(서버)** 을 구현했어요.
호스트(맥)가 클라이언트로 접속해 오고, 게스트 커널이 서버가 됩니다.
흐름은 이래요 — SYN을 기다리다가, 받으면 자기 ISN(`20000`)을 담은 SYN-ACK로 답하고, 데이터를 받아 에코하고, FIN으로 닫아요.

```c
void net_tcp_demo(void) {
    uint16 myport = 5599;
    uint8 pmac[6], pip[4]; uint16 pport = 0;
    uint32 rseq, rack; uint8 fl; uint8 buf[BUFSZ];

    // 1) SYN 대기 — TH_SYN 플래그가 켜진 세그먼트가 올 때까지
    for (;;) {
        int n = tcp_recv(myport, pmac, pip, &pport, &rseq, &rack, &fl, buf, sizeof(buf));
        if (n < 0) { uart_puts("timeout (no connect)\n"); return; }
        if (fl & TH_SYN) break;             // SYN 도착 → 핸드셰이크 시작
    }
    uint32 cliseq = rseq;                    // 상대의 ISN을 장부에 기록

    // 2) SYN-ACK — 우리 ISN=20000, ack=상대 ISN+1 (SYN이 seq 1 소비하니까)
    uint32 myseq = 20000;
    tcp_send(pmac, pip, myport, pport, myseq, cliseq + 1, TH_SYN | TH_ACK, 0, 0);
    myseq += 1;                              // 우리 SYN도 seq 1 소비
    uint32 cliack = cliseq + 1;              // 상대에게서 다음에 기대하는 seq
    // 3) 이후 데이터 수신 → 에코 → FIN 종료 (4절에서)
}
```

`tcp_recv`의 `want_port` 인자가 핵심이에요 — **우리 포트(5599)로 온 세그먼트만** 골라내고, 그 세그먼트에서 상대 MAC(이더넷 src)·IP(IP src)·포트(TCP src)·seq·ack·플래그를 한꺼번에 뽑아 장부에 채워요. 서버는 "누가 올지" 모르니, 받은 세그먼트에서 상대 주소를 역으로 알아내는 거죠.

```c
// tcp_recv: 우리 포트로 온 TCP 세그먼트에서 상대 정보 + 장부 숫자를 추출
if (get16(t + 2) != want_port) continue;     // 우리 포트로 온 것만
if (pmac) copy(pmac, fr + 6, 6);             // 상대 MAC = 이더넷 src
if (pip)  copy(pip, ip + 12, 4);             // 상대 IP  = IP src
if (pport) *pport = get16(t + 0);            // 상대 포트 = TCP src
*seq = get32(t + 4); *ack = get32(t + 8); *flags = t[13];
```

## 4. 세그먼트와 의사헤더 체크섬

### 20바이트 TCP 헤더

TCP 세그먼트는 IP 위에 **20바이트 헤더**를 얹어요.
포트(출발/도착), seq, ack, 데이터 오프셋+플래그, 윈도우, 체크섬 — 이게 한 칸씩 직렬화됩니다.

```c
// tcp_send: IP 헤더(20B) 뒤에 TCP 헤더(20B)를 빌드한다
uint8 *t = pkt + 20;
put16(t + 0, sport);  put16(t + 2, dport);   // 출발/도착 포트
put32(t + 4, seq);    put32(t + 8, ack);      // 시퀀스 / 확인 응답 번호
t[12] = (5 << 4);                             // data offset=5 → 헤더 20바이트
t[13] = flags;                                // SYN/ACK/FIN/PSH/RST
put16(t + 14, 64240);                         // window (받을 수 있는 양)
put16(t + 16, 0);  put16(t + 18, 0);          // checksum 자리, urgent
```

플래그는 비트 한 칸씩이에요. 우리가 쓰는 다섯 개:

```c
#define TH_FIN 0x01    // 더 보낼 데이터 없음 (연결 종료 시작)
#define TH_SYN 0x02    // 연결 수립 (ISN 동기화)
#define TH_RST 0x04    // 연결 강제 리셋
#define TH_PSH 0x08    // 버퍼링 말고 바로 올려라
#define TH_ACK 0x10    // ack 번호가 유효하다
```

`data offset=5`는 *"헤더가 32비트 워드 5개 = 20바이트"* 라는 뜻이에요. TCP는 옵션을 붙이면 헤더가 길어질 수 있어서, 헤더 길이를 따로 적어요. 우리는 옵션을 안 쓰니 항상 5(20바이트)예요.
`window=64240`은 *"내가 한 번에 받을 수 있는 바이트 수"* 인데, 우리는 흐름 제어를 안 하니 그냥 고정값을 박아 둡니다(5절 참고).

### 의사헤더 체크섬 — UDP와 같은 방식, 프로토콜 번호만 다름

> 체크섬은 "전송 중 비트가 깨지지 않았나"를 검증해요. 그런데 TCP 체크섬은 TCP 헤더만 보는 게 아니라, **IP 주소까지 끌어와서** 계산해요. 왜 자기 계층도 아닌 IP 주소를 넣을까요?

이유는 *"이 세그먼트가 정말 이 출발지→도착지 쌍으로 가는 게 맞나"* 까지 검증하기 위해서예요.
IP 헤더 자체는 이미 IP 체크섬(IPv4)으로 보호돼요. 의사헤더(pseudo-header)의 목적은 따로 있어요 — 세그먼트가 **다른 endpoint로 잘못 전달되는 경우(misdelivery)** 를 잡는 거죠. 출발/도착 IP를 체크섬에 섞으면, 엉뚱한 목적지로 새어든 세그먼트는 체크섬이 안 맞아 걸러집니다.

이건 [7편의 UDP](/blog/hobby/hobby-kernel-06-networking)와 **완전히 같은 방식**이에요. 딱 하나, 의사헤더의 프로토콜 번호만 UDP(17)에서 TCP(6)로 바뀝니다.

```c
// tcp_send: 의사헤더(출발IP+도착IP+proto+길이) + TCP 세그먼트를 16비트씩 합산
uint32 sum = 0;
sum += get16(MY_IP) + get16(MY_IP + 2) + get16(dip) + get16(dip + 2);  // 의사헤더: 두 IP
sum += IP_TCP + tcplen;                                                 // proto=6, TCP 길이
for (int i = 0; i + 1 < tcplen; i += 2) sum += get16(t + i);            // TCP 헤더+데이터
if (tcplen & 1) sum += (uint16)t[tcplen - 1] << 8;                      // 홀수 바이트 패딩
while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);                   // 1의 보수 접기
put16(t + 16, ~sum & 0xffff);                                          // 보수 → 체크섬 칸
```

`IP_TCP`가 6이라는 것만 빼면 7편 UDP의 체크섬 코드와 글자 단위로 같아요. *"의사헤더 + 세그먼트를 16비트씩 더하고, 캐리를 접고, 1의 보수를 취한다"* — 이 패턴이 IP·ICMP·UDP·TCP에 전부 공통입니다.

## 5. 한 연결의 전 생애 — 핸드셰이크부터 종료까지

이제 4절의 SYN-ACK 다음을 이어 붙여, 한 연결의 **시작부터 끝까지**를 봅니다.

### 데이터 수신과 에코

SYN-ACK를 보낸 뒤, 서버는 호스트의 ACK(핸드셰이크 마무리)와 그 뒤에 올 데이터를 기다려요.
데이터가 오면 그대로 되돌려 보내는(에코) 게 우리 데모의 일이에요.

```c
// 3) 핸드셰이크 ACK + 데이터 수신 (데이터가 올 때까지 최대 12번 시도)
for (int tries = 0; tries < 12; tries++) {
    n = tcp_recv(myport, 0, 0, 0, &rseq, &rack, &fl, buf, sizeof(buf));
    if (n < 0) { uart_puts("[tcp] no data\n"); return; }
    if (n > 0) {                                  // 페이로드가 있다 = 진짜 데이터
        uart_puts("[tcp] recv: ");
        for (int i = 0; i < n; i++) uart_putc((char)buf[i]);
        cliack = rseq + n;                        // "데이터 n바이트까지 받았다"

        // 4) 에코 + ACK — 받은 걸 그대로 PSH|ACK로 돌려준다
        tcp_send(pmac, pip, myport, pport, myseq, cliack, TH_PSH | TH_ACK, buf, n);
        myseq += n;                               // 보낸 데이터만큼 내 seq 전진
        break;
    }
    if (fl & TH_FIN) { cliack = rseq + 1; break; } // 데이터 없이 바로 닫으면 FIN 처리
}
```

여기서 2절의 회계가 양방향으로 맞물려요.
받은 데이터 n바이트에 대해 `cliack = rseq + n`으로 *"여기까지 받았다"* 를 기록하고(상대 스트림 추적), 에코로 n바이트를 보낸 뒤 `myseq += n`으로 *"여기까지 보냈다"* 를 기록해요(내 스트림 추적).
**받은 쪽 장부는 +n, 보낸 쪽 장부도 +n** — 두 칸이 동시에 굴러갑니다.

### 종료 — FIN도 seq 1을 소비

연결을 닫을 때도 회계는 멈추지 않아요.

```c
// 5) 종료: FIN 보내고, 상대 FIN에 ACK로 답한다
tcp_send(pmac, pip, myport, pport, myseq, cliack, TH_FIN | TH_ACK, 0, 0);
n = tcp_recv(myport, 0, 0, 0, &rseq, &rack, &fl, buf, sizeof(buf));
if (n >= 0 && (fl & TH_FIN))
    tcp_send(pmac, pip, myport, pport, myseq + 1, rseq + 1, TH_ACK, 0, 0);
//                                  ↑ 내 FIN이 seq 1 소비   ↑ 상대 FIN이 seq 1 소비
```

마지막 ACK에서 내 seq가 `myseq + 1`인 건 **방금 보낸 FIN이 seq 1을 소비했기 때문**이고, ack가 `rseq + 1`인 건 **상대 FIN도 seq 1을 소비했기 때문**이에요.
2절에서 *"SYN과 FIN은 데이터 없이 seq 1을 소비한다"* 고 한 규칙이, 연결의 양 끝(SYN으로 열고 FIN으로 닫는)에서 똑같이 작동하는 걸 코드로 확인하는 순간이에요.

> 실제 TCP 종료는 보통 **FIN → ACK → FIN → ACK** 네 단계(각자 따로 닫음)인데, 우리는 양쪽을 합쳐 단순화했어요.

그리고 한 연결이 거쳐 가는 상태를 그림으로 보면 — 우리 코드는 이 흐름을 **명시적 상태 변수 없이 일직선 코드로** 밟아 갑니다:

![수동 개방 서버가 거치는 TCP 상태: LISTEN → SYN_RCVD → ESTABLISHED(데이터 수신·에코) → CLOSE_WAIT → LAST_ACK → CLOSED](/uploads/hobby/hobby-kernel-c/tcp-states.svg)

진짜 TCP는 이 상태들을 상태 머신으로 명시 관리하지만(동시 연결·재전송 때문), 우리 수동 개방 서버는 한 연결을 순서대로 처리하니 코드의 진행이 곧 상태 전이예요.

### 폴링이라는 단순화

한 가지 솔직하게 짚을 게 있어요 — 우리 스택은 **인터럽트 없이 used 링을 폴링**해요(7편에서 만든 그대로).
`tcp_recv`는 세그먼트가 올 때까지 루프를 돌며 기다리고, 일정 횟수를 넘기면 타임아웃으로 빠져나옵니다.

```c
// tcp_recv: 인터럽트 없이 프레임을 폴링하다가, 우리 포트 TCP만 골라낸다
for (uint64 spin = 0; spin < 800000000ULL; spin++) {
    int len = eth_rx(fr, sizeof(fr));
    if (len <= 0) { if (len < 0) return -1; continue; }
    if (get16(fr + 12) == ETH_ARP) { arp_maybe_reply(fr, len); continue; } // 그 사이 ARP도 응답
    // ... IPv4 + TCP + want_port 필터링 후 장부 추출
}
```

폴링이라 *"한 흐름에서 한 세그먼트씩"* 순차로 처리해요. 이 단순함이 다음 절(빼놓은 것)의 전제가 됩니다 — 동시에 여러 세그먼트가 in-flight인 상황을 우리는 아예 만들지 않거든요.

## 6. 눈으로 확인하기 — hostfwd 왕복

### QEMU hostfwd로 호스트를 끌어들이기

검증은 QEMU의 **hostfwd**(호스트 포트 → 게스트 포트)로 했어요.
QEMU user 네트워킹(SLIRP)이 호스트의 어떤 포트로 온 접속을 게스트의 `10.0.2.15:5599`로 넘겨줘요.
그러면 게스트 커널이 서버(수동 개방)가 되고, 맥에서 그 포트로 접속하는 평범한 TCP 클라이언트(예: `nc`나 파이썬 소켓)가 클라이언트가 됩니다.

게스트(커널) 쪽 로그:

```
[tcp] listening on :5599 (waiting for host connect) ...
SYN from 10.0.2.2                          ← 핸드셰이크 시작 (SLIRP 게이트웨이를 거쳐 옴)
[tcp] recv: hi from host over TCP          ← 호스트가 보낸 데이터 수신
[ok] tcp: accept + handshake + echo + close done
```

호스트 쪽:

```
host got echo: b'hi from host over TCP\n'   ← 게스트가 에코한 걸 그대로 돌려받음
```

### 이 네 줄이 증명하는 것

- `SYN from 10.0.2.2` — 호스트의 능동 개방 SYN이 우리 서버의 `tcp_recv`에 `TH_SYN`으로 잡혔어요. 출발지가 `10.0.2.2`인 건 SLIRP 게이트웨이를 거쳐 들어왔다는 뜻이에요(NAT). 우리 서버가 SYN-ACK로 답하고 ISN 20000을 알린 게 이 줄 직후예요.
- `[tcp] recv: ...` — 핸드셰이크 ACK가 끝나고 실제 데이터가 우리 포트로 들어와, 페이로드를 그대로 UART에 찍은 거예요. **호스트가 친 바이트가 게스트 커널의 TCP 스택을 끝까지 타고 들어온** 순간입니다.
- `host got echo: ...` — 그 데이터를 `TH_PSH | TH_ACK`로 에코한 게 SLIRP를 거꾸로 타고 호스트 소켓으로 돌아갔어요. **왕복이 닫혔다**는 결정적 증거예요.
- `[ok] ... close done` — FIN 교환까지 끝났다는 뜻이에요.

`SYN → SYN-ACK → ACK → 데이터 → 에코 → FIN`, **연결의 전 생애가 한 번에 동작**한 거예요.
2절의 장부, 3절의 핸드셰이크, 4절의 체크섬, 5절의 종료가 이 왕복 한 번에 전부 검증됩니다.

## 7. 되짚기 — 일부러 빼놓은 것

우리 TCP는 **연결 하나, 한 번의 데이터 교환**까지예요.
진짜 TCP를 떠받치는 무거운 부분들은 일부러 뺐어요 — 그게 어떤 비용을 절약했는지 정직하게 적습니다.

| 빠진 것 | 진짜 TCP가 하는 일 | 우리가 뺀 이유 |
|---------|-------------------|---------------|
| **재전송 타이머** | ACK가 안 오면 타이머 만료 후 다시 보냄 | 폴링 한 흐름이라 손실을 가정하지 않음 |
| **혼잡 제어**(슬로스타트·AIMD) | 네트워크가 막히면 전송 속도를 줄임 | 인터넷 규모의 문제 — 토이 커널 범위 밖 |
| **윈도우/흐름 제어** | 받는 쪽이 감당할 만큼만 보냄 | 한 세그먼트씩만 주고받음(window 값은 고정) |
| **재정렬 버퍼** | 순서 뒤바뀐 세그먼트를 모아 재배열 | 재전송이 없고 한 번에 하나만 in-flight이라 뒤바뀜이 사실상 안 생김 |

> **흔한 오해 정정**: *"이걸 다 빼면 TCP가 아니지 않나?"* — 맞기도 하고 틀리기도 해요. 우리가 구현한 건 **TCP 와이어 포맷과 상태 전이의 핵심**(시퀀스 회계 + 3-way 핸드셰이크 + 의사헤더 체크섬)이고, 뺀 것들은 *"신뢰성을 실제 인터넷 환경에서 견고하게 만드는 메커니즘"* 이에요. 핵심은 동작하지만, 이대로 패킷 손실이 잦은 실제 망에 던지면 멈춰버립니다. 그래서 정직하게 *"교육용 최소 구현"* 이라고 부르는 거예요.

이걸 다 합치면 TCP는 그 자체로 **커널만큼 큰 주제**예요.
이번 글의 목표는 **"신뢰성이 시퀀스 번호와 핸드셰이크에서 어떻게 시작되나"** 를 손으로 만져보는 거였고, 거기까진 이 최소 구현으로 완전히 보여요.
**"본질의 이해 ↔ 프로덕션 완전성"** 의 트레이드오프에서 본질을 택한 거예요.

## 정리

UDP에서 TCP로 오는 길은 *"패킷"* 에서 *"스트림"* 으로, *"던지고 잊기"* 에서 *"번호 매기고 확인하기"* 로의 전환이었어요. 핵심을 한 방향으로 쌓아 보면.

- **TCP가 푸는 문제** — IP는 손실·뒤바뀜·복제를 막지 않아요. TCP는 *모든 바이트에 번호를 매겨* 도착·순서·연결을 보장합니다.
- **시퀀스 회계** — `(내 seq, 내 ack)` 두 칸이 양쪽 스트림을 추적해요. SYN과 FIN은 데이터가 없어도 seq를 1 소비합니다. 코드에선 `myseq += 1`(SYN/FIN), `myseq += n`(데이터)으로 나타나요.
- **3-way 핸드셰이크** — 두 스트림의 ISN을 *"알림+확인"* 하는 데 가운데 메시지가 ACK를 겸해서 정확히 세 번이 돼요. 우리는 **수동 개방(서버)** 을 구현해, SYN을 기다렸다가 SYN-ACK(ISN=20000)로 답합니다.
- **세그먼트 + 체크섬** — 20바이트 헤더(포트·seq·ack·offset+flags·window·checksum)에, 7편 UDP와 같은 의사헤더 체크섬(proto만 17→6).
- **hostfwd 검증** — `SYN → SYN-ACK → ACK → 데이터 → 에코 → FIN`의 전 생애가 호스트↔게스트 왕복 한 번으로 동작했어요.
- **일부러 뺀 것** — 재전송·혼잡 제어·윈도우·재정렬. 핵심은 살리고, 인터넷 규모의 견고함은 트레이드오프로 미뤘어요.

seq와 ack라는 두 숫자가 신뢰성의 **출발점**이라는 게 TCP의 우아함이에요(완전한 신뢰성엔 타이머·재전송·윈도우·혼잡 제어·상태 머신이 더 필요하지만, 그 모든 회계의 씨앗이 이 두 숫자죠).
그 우아함의 씨앗을 핸드셰이크 한 번과 에코 한 번으로 손에 쥐어 본 게 이번 작업이었어요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

## 참고 (1차 자료 우선)

- [RFC 9293 — Transmission Control Protocol (TCP)](https://www.rfc-editor.org/rfc/rfc9293) — 현행 TCP 표준. 시퀀스 회계, 3-way 핸드셰이크, 의사헤더 체크섬, 상태 전이의 1차 정의
- [RFC 793 — Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc793) — 원본 TCP 명세(9293으로 갱신됨). SYN/FIN이 seq를 소비한다는 규칙의 원전
- [RFC 768 — User Datagram Protocol](https://www.rfc-editor.org/rfc/rfc768) — UDP 명세. 의사헤더 체크섬 방식이 TCP와 공유됨
- [RFC 1122 — Requirements for Internet Hosts](https://www.rfc-editor.org/rfc/rfc1122) — 호스트 구현 요구사항(체크섬·재전송 등)
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — 이 커널의 참고서
- [QEMU User Networking (SLIRP) / hostfwd](https://www.qemu.org/docs/master/system/devices/net.html) — hostfwd로 호스트→게스트 포트 포워딩
- 관련 글: [네트워킹 — virtio-net과 미니 스택](/blog/hobby/hobby-kernel-06-networking) — 이 글이 올라탄 UDP까지의 스택

<!-- EN -->

*A RISC-V toy kernel built from scratch — a blog series. This is Part 10: putting a **minimal TCP** (3-way handshake + seq/ack accounting) on top of the [network stack](/blog/hobby/hobby-kernel-06-networking) that went up to UDP.*

## 0. Introduction

The [network stack from Part 7](/blog/hobby/hobby-kernel-06-networking) went up to UDP.
UDP is simple — build one packet, fire it off, done.
It doesn't care whether it arrived or whether the order is right. It **fires and forgets**.

TCP makes a different promise.
"What you send is delivered, in order, *to the application*." (The packets themselves may arrive out of order or duplicated; TCP reorders them internally so the *app* sees them in order.)
But the network layer we ride on (IP) makes no such promise — packets can vanish, get reordered, or be duplicated.
TCP is the protocol that **builds a trustworthy byte stream on top of that untrustworthy floor**.

This post has one core question — **where does that reliability actually come from?**
The answer isn't magic; it's **numbering**.
We use that numbering (sequence numbers and ACKs) to implement TCP's heart, the **3-way handshake**, and build a **passive-open (server)** that actually exchanges data with the host.
Then we honestly account for **what we deliberately left out** (retransmission, congestion control, windows).

> Why hand-roll TCP: UDP fits in one post, but TCP packs sequence accounting, the handshake, checksums, and state transitions all into the single word "reliability." Building it by hand once turns "why TCP is expensive" from abstract knowledge into the felt weight of code.

## 1. The Real Problem TCP Has to Solve

> You sent three packets "1, 2, 3" over UDP. If the receiver got only "1, 3", or got them as "2, 1, 3", the receiver **can't even tell**. How do you ever notice "something's missing" or "the order is wrong"?

Concretely, here's UDP's limit:

```
sender:    [seg 1] [seg 2] [seg 3]
                    ↓ the network (IP) guarantees nothing
receiver:  [seg 1] [seg 3]            ← seg 2 vanished, but the receiver has no idea
receiver:  [seg 2] [seg 1] [seg 3]    ← reordered, but the receiver has no idea
```

A UDP header carries only **ports, length, and a checksum**.
There's no field for "which packet number this is," so the receiver has no way to detect loss or reordering.
That's the true meaning of *"fire and forget"* — the sender doesn't know it arrived, and the receiver doesn't know it got everything.

So TCP's problem boils down to three things.

1. **Delivery guarantee**: if something is lost, how do you know and resend it?
2. **Ordering guarantee**: if it arrives scrambled, how do you restore the original order?
3. **Start and end of a connection**: how do both sides agree on "conversation begins now" and "we're done"?

The common solution to all three is **"number every byte."**
With numbers you can say *"I received up to N"* (delivery check), spot *"a number is missing"* (retransmit trigger), and *"reorder by number"* (reordering).
What we implement in this post are the **seeds** of #1 and #3 (delivery confirmation and connection agreement); #2 and full #1 (retransmission/reordering), plus TCP's other core piece — **flow control (the window)** — we cover in §7 as *"why we left them out on purpose."*

## 2. Background — Sequence Accounting as a Two-Way Ledger

TCP's reliability comes from two **ledger** entries each side holds.

### What the two numbers seq and ack do

> In one connection, data flows both ways. But "what I sent" and "what I received" are entirely different numbers. How do you track both at once?

- **seq** (sequence number): *"this byte I'm sending now is the Nth in my stream."*
- **ack** (acknowledgment number): *"I've received the peer's stream up to here; send from this number next."*

The key is that seq and ack point at **two different streams**.
My seq is the position in *"the flow I'm sending"*; my ack is the position I've received in *"the flow the peer sends."*
So if each side holds one pair `(my seq, my ack)`, the entire connection's progress is fully described by two pairs.

In our actual code this ledger shows up as plain variables.

```c
// net_tcp_demo() — the ledger the server holds
uint32 myseq = 20000;          // current position of "the flow I send" (our ISN)
uint32 cliseq;                 // the seq the peer (client) sent
uint32 cliack = cliseq + 1;    // "the seq I next expect from the peer" = my ack
```

Each time `tcp_recv` receives a segment it pulls the peer's seq/ack/flags and updates this ledger; when replying with `tcp_send` it carries my seq and the ack (the position I've received from the peer).

### A common misconception — "SYN/FIN carry no data, so they use no number"?

> **Common misconception fix**: SYN and FIN have a 0-byte payload. So it's easy to think *"empty packet, so it must not consume a sequence number"* — the **opposite** is true. **SYN and FIN consume exactly one sequence number even with no data.** The *"start"* and *"end"* of a connection are also counted as a point in the stream. Without this you'd have no way to confirm "did my SYN arrive?" — confirmation is done by ack, and ack points at a *number*, so SYN must occupy one.

This rule is baked directly into the code.

```c
// after sending SYN-ACK, bump our seq by 1 (the SYN consumed seq 1)
tcp_send(pmac, pip, myport, pport, myseq, cliseq + 1, TH_SYN | TH_ACK, 0, 0);
myseq += 1;                    // ← the SYN flag consumes seq 1 (RFC: "SYN occupies one sequence number")
```

```c
// after echoing n bytes of data, advance by that length
tcp_send(..., myseq, cliack, TH_PSH | TH_ACK, buf, n);
myseq += n;                    // ← data consumes its byte count
```

SYN is `+1`, data is `+n`, FIN is `+1` too.
**"Advance seq by however much you sent (in bytes, or in control flags)"** — that one-line rule is the whole of TCP accounting.

### UDP vs TCP — what makes reliability

| Aspect | UDP | TCP |
|--------|-----|-----|
| Transmission model | packet (datagram) | byte stream |
| Numbers in header | none | seq (sent position) + ack (received position) |
| Delivery guarantee | none (fire and forget) | confirmed by ack; resend if absent |
| Ordering guarantee | none | reorder by seq |
| Connection | none (stateless) | established by 3-way handshake |
| Header size | 8 bytes | 20 bytes minimum |
| Our implementation scope | finished in Part 7 | seq/ack accounting + handshake + echo (this post) |

> **Key lesson**: every difference between UDP and TCP derives from one thing — **whether the header records a number**. With numbers, confirmation (ack) is possible; with numbers and acks you can *implement* retransmission (together with a timer); with numbers, reordering is possible. (Numbering alone doesn't retransmit — acks and a timer are what tell you *when* something was lost; this post builds only that foundation.) **Reliability comes from numbering.**

## 3. The 3-Way Handshake — Why Exactly Three

A connection begins with three greetings.

![TCP 3-way handshake: client SYN(seq=x) → server SYN-ACK(seq=y, ack=x+1) → client ACK(ack=y+1) → connection ESTABLISHED](/uploads/hobby/hobby-kernel-c/tcp-handshake-en.svg)

### Why not two, not four, but three

> One is too few, two won't do, and four would be wasteful. Why is exactly three needed?

The key is that **each side must announce its own initial number (ISN) to the other and have receipt confirmed**.
A connection is bidirectional, so there are **two streams**, and each stream needs *"announce my start number to you → you confirm it."*

- The client's ISN (`x`): announced by message 1 (SYN), confirmed by message 2 (the `ack=x+1` in SYN-ACK)
- The server's ISN (`y`): announced by message 2 (SYN-ACK), confirmed by message 3 (the `ack=y+1` in ACK)

So you need two *"announce+confirm"* pairs, but the middle message 2 **serves as both the server's SYN and the ACK of the client's SYN**, collapsing four into three.
That's why the minimum is exactly **three**.

> Going one step deeper — the more fundamental reason the RFC gives is to **reject "old duplicate SYNs"** ([RFC 9293](https://datatracker.ietf.org/doc/html/rfc9293)). A SYN from an old connection can linger in the network and arrive late; with the 3-way exchange of ISNs, a ghost SYN the peer *can't confirm (ACK)* is naturally ignored. So the 3-way is both "ISN synchronization" and **"defense against old duplicate packets."** This post's "announce+confirm" framing is looking at the synchronization side.

> **Common misconception fix**: it's easy to think *"the handshake is merely the ritual that 'opens' a connection, separate from data transfer"* — but the handshake is already **the start of sequence accounting**. The SYN carries an ISN, that ISN consumes seq 1, and the peer replies with `ISN+1` as ack — the very accounting from §2 is at work in the handshake. The handshake is both sides agreeing on "the first line of the ledger."

### We implemented the passive open (server)

A TCP connection opens in two ways.

- **Active open**: the side that sends the SYN first to dial a connection — usually the **client**
- **Passive open**: the side that opens a port and **waits** for someone to send a SYN — usually the **server**

We implemented the **passive open (server)** side.
The host (Mac) connects as the client, and the guest kernel becomes the server.
The flow: wait for a SYN, and on receiving one reply with a SYN-ACK carrying its own ISN (`20000`), receive data and echo it, then close with a FIN.

```c
void net_tcp_demo(void) {
    uint16 myport = 5599;
    uint8 pmac[6], pip[4]; uint16 pport = 0;
    uint32 rseq, rack; uint8 fl; uint8 buf[BUFSZ];

    // 1) wait for SYN — until a segment with the TH_SYN flag set arrives
    for (;;) {
        int n = tcp_recv(myport, pmac, pip, &pport, &rseq, &rack, &fl, buf, sizeof(buf));
        if (n < 0) { uart_puts("timeout (no connect)\n"); return; }
        if (fl & TH_SYN) break;             // SYN arrived → handshake begins
    }
    uint32 cliseq = rseq;                    // record the peer's ISN in the ledger

    // 2) SYN-ACK — our ISN=20000, ack=peer ISN+1 (since SYN consumes seq 1)
    uint32 myseq = 20000;
    tcp_send(pmac, pip, myport, pport, myseq, cliseq + 1, TH_SYN | TH_ACK, 0, 0);
    myseq += 1;                              // our SYN also consumes seq 1
    uint32 cliack = cliseq + 1;              // the seq we next expect from the peer
    // 3) then receive data → echo → FIN close (in §5)
}
```

The `want_port` argument to `tcp_recv` is the crux — it picks out **only segments arriving at our port (5599)** and, from that segment, pulls the peer's MAC (Ethernet src), IP (IP src), port (TCP src), seq, ack, and flags all at once into the ledger. The server doesn't know "who will come," so it learns the peer's address in reverse from the segment it received.

```c
// tcp_recv: extract the peer's info + the ledger numbers from a segment on our port
if (get16(t + 2) != want_port) continue;     // only what came to our port
if (pmac) copy(pmac, fr + 6, 6);             // peer MAC = Ethernet src
if (pip)  copy(pip, ip + 12, 4);             // peer IP  = IP src
if (pport) *pport = get16(t + 0);            // peer port = TCP src
*seq = get32(t + 4); *ack = get32(t + 8); *flags = t[13];
```

## 4. Segments and the Pseudo-Header Checksum

### The 20-byte TCP header

A TCP segment puts a **20-byte header** on top of IP.
Ports (source/destination), seq, ack, data offset + flags, window, checksum — each gets serialized field by field.

```c
// tcp_send: build the TCP header (20B) right after the IP header (20B)
uint8 *t = pkt + 20;
put16(t + 0, sport);  put16(t + 2, dport);   // source / destination ports
put32(t + 4, seq);    put32(t + 8, ack);      // sequence / acknowledgment numbers
t[12] = (5 << 4);                             // data offset=5 → 20-byte header
t[13] = flags;                                // SYN/ACK/FIN/PSH/RST
put16(t + 14, 64240);                         // window (how much we can receive)
put16(t + 16, 0);  put16(t + 18, 0);          // checksum slot, urgent
```

Flags are one bit each. The five we use:

```c
#define TH_FIN 0x01    // no more data to send (begin close)
#define TH_SYN 0x02    // establish connection (synchronize ISN)
#define TH_RST 0x04    // forcibly reset the connection
#define TH_PSH 0x08    // don't buffer, push it up now
#define TH_ACK 0x10    // the ack number is valid
```

`data offset=5` means *"the header is 5 32-bit words = 20 bytes."* TCP can carry options that lengthen the header, so the header length is recorded separately. We use no options, so it's always 5 (20 bytes).
`window=64240` is *"how many bytes I can receive at once,"* but since we do no flow control we just hard-code a fixed value (see §7).

### Pseudo-header checksum — same as UDP, only the protocol number differs

> The checksum verifies "no bits got corrupted in transit." But the TCP checksum doesn't cover just the TCP header — it **pulls in the IP addresses too**. Why include IP addresses that aren't even its own layer?

The reason is to also verify *"is this segment really going to this exact source→destination pair?"*
The IP header itself is already protected by the IP checksum (IPv4). The pseudo-header's purpose is different — to catch a segment **misdelivered to the wrong endpoint.** By mixing the source/destination IPs into the checksum, a segment that leaked to the wrong destination fails the checksum and is filtered out.

This is **exactly the same scheme** as [UDP in Part 7](/blog/hobby/hobby-kernel-06-networking). Just one thing changes: the protocol number in the pseudo-header, from UDP (17) to TCP (6).

```c
// tcp_send: sum the pseudo-header (src IP + dst IP + proto + len) + TCP segment in 16-bit words
uint32 sum = 0;
sum += get16(MY_IP) + get16(MY_IP + 2) + get16(dip) + get16(dip + 2);  // pseudo-header: two IPs
sum += IP_TCP + tcplen;                                                 // proto=6, TCP length
for (int i = 0; i + 1 < tcplen; i += 2) sum += get16(t + i);            // TCP header + data
if (tcplen & 1) sum += (uint16)t[tcplen - 1] << 8;                      // odd-byte padding
while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);                   // fold the one's-complement carry
put16(t + 16, ~sum & 0xffff);                                          // complement → checksum slot
```

Aside from `IP_TCP` being 6, this is byte-for-byte identical to Part 7's UDP checksum code. *"Sum the pseudo-header + segment in 16-bit words, fold the carry, take the one's complement"* — that pattern is common to IP, ICMP, UDP, and TCP alike.

## 5. The Full Life of One Connection — From Handshake to Close

Now we continue from §4's SYN-ACK to see one connection **from start to finish**.

### Receiving data and echoing

After sending the SYN-ACK, the server waits for the host's ACK (finishing the handshake) and the data that follows.
When data arrives, our demo's job is to send it straight back (echo).

```c
// 3) handshake ACK + data receive (up to 12 tries until data arrives)
for (int tries = 0; tries < 12; tries++) {
    n = tcp_recv(myport, 0, 0, 0, &rseq, &rack, &fl, buf, sizeof(buf));
    if (n < 0) { uart_puts("[tcp] no data\n"); return; }
    if (n > 0) {                                  // there's a payload = real data
        uart_puts("[tcp] recv: ");
        for (int i = 0; i < n; i++) uart_putc((char)buf[i]);
        cliack = rseq + n;                        // "received up to data byte n"

        // 4) echo + ACK — send what we got straight back as PSH|ACK
        tcp_send(pmac, pip, myport, pport, myseq, cliack, TH_PSH | TH_ACK, buf, n);
        myseq += n;                               // advance my seq by the bytes sent
        break;
    }
    if (fl & TH_FIN) { cliack = rseq + 1; break; } // if it closes without data, handle FIN
}
```

Here §2's accounting interlocks in both directions.
For the n bytes received we record *"received up to here"* with `cliack = rseq + n` (tracking the peer's stream), and after echoing n bytes we record *"sent up to here"* with `myseq += n` (tracking my own stream).
**The receive-side ledger goes +n, and the send-side ledger goes +n too** — both entries roll forward at once.

### Close — FIN also consumes seq 1

The accounting doesn't stop when closing the connection.

```c
// 5) close: send FIN, then reply to the peer's FIN with an ACK
tcp_send(pmac, pip, myport, pport, myseq, cliack, TH_FIN | TH_ACK, 0, 0);
n = tcp_recv(myport, 0, 0, 0, &rseq, &rack, &fl, buf, sizeof(buf));
if (n >= 0 && (fl & TH_FIN))
    tcp_send(pmac, pip, myport, pport, myseq + 1, rseq + 1, TH_ACK, 0, 0);
//                                  ↑ my FIN consumed seq 1   ↑ peer's FIN consumed seq 1
```

In the final ACK, my seq being `myseq + 1` is **because the FIN I just sent consumed seq 1**, and the ack being `rseq + 1` is **because the peer's FIN also consumed seq 1**.
This is the moment you confirm in code that the §2 rule — *"SYN and FIN consume seq 1 with no data"* — works identically at both ends of the connection (opening with SYN, closing with FIN).

> A real TCP close is usually **FIN → ACK → FIN → ACK** (each side closes separately); we simplified it by combining the two sides.

And here's the lifecycle a connection walks through — our code walks it **with no explicit state variable, just straight-line code**:

![TCP states a passive-open server walks: LISTEN → SYN_RCVD → ESTABLISHED (receive data, echo) → CLOSE_WAIT → LAST_ACK → CLOSED](/uploads/hobby/hobby-kernel-c/tcp-states-en.svg)

Real TCP manages these states explicitly with a state machine (for concurrent connections and retransmission), but our passive-open server handles one connection in order, so the code's progress *is* the state transition.

### Polling as a simplification

One thing to state honestly — our stack **polls the used ring with no interrupts** (exactly as built in Part 7).
`tcp_recv` loops waiting for a segment, and bails out with a timeout after a spin count.

```c
// tcp_recv: poll frames with no interrupts, then filter only our-port TCP
for (uint64 spin = 0; spin < 800000000ULL; spin++) {
    int len = eth_rx(fr, sizeof(fr));
    if (len <= 0) { if (len < 0) return -1; continue; }
    if (get16(fr + 12) == ETH_ARP) { arp_maybe_reply(fr, len); continue; } // answer ARP in the meantime
    // ... filter IPv4 + TCP + want_port, then extract the ledger
}
```

Because it polls, we process *"one segment at a time in a single flow."* That simplicity is the premise of the next section (what we left out) — we never create a situation with several segments in-flight at once.

## 6. Seeing It With Your Own Eyes — the hostfwd Round-Trip

### Pulling the host in with QEMU hostfwd

Verification used QEMU's **hostfwd** (host port → guest port).
QEMU user networking (SLIRP) forwards a connection arriving at some host port to the guest's `10.0.2.15:5599`.
The guest kernel becomes the server (passive open), and an ordinary TCP client on the Mac (e.g. `nc` or a Python socket) connecting to that port is the client.

The guest (kernel) side log:

```
[tcp] listening on :5599 (waiting for host connect) ...
SYN from 10.0.2.2                          ← handshake begins (arrived via the SLIRP gateway)
[tcp] recv: hi from host over TCP          ← received the data the host sent
[ok] tcp: accept + handshake + echo + close done
```

The host side:

```
host got echo: b'hi from host over TCP\n'   ← got back exactly what the guest echoed
```

### What these four lines prove

- `SYN from 10.0.2.2` — the host's active-open SYN was caught by our server's `tcp_recv` with `TH_SYN`. The source being `10.0.2.2` means it came in through the SLIRP gateway (NAT). Our server answered with a SYN-ACK announcing ISN 20000 right after this line.
- `[tcp] recv: ...` — after the handshake ACK, real data arrived at our port and we dumped the payload straight to the UART. This is the moment **the bytes the host typed rode all the way through the guest kernel's TCP stack**.
- `host got echo: ...` — that data, echoed as `TH_PSH | TH_ACK`, rode back through SLIRP to the host's socket. The decisive evidence that **the round-trip closed**.
- `[ok] ... close done` — the FIN exchange finished too.

`SYN → SYN-ACK → ACK → data → echo → FIN`, **the entire life of a connection worked in one go**.
§2's ledger, §3's handshake, §4's checksum, and §5's close are all verified in this single round-trip.

## 7. Looking Back — What We Deliberately Left Out

Our TCP goes as far as **one connection, one data exchange**.
The heavy parts that hold up real TCP we left out on purpose — and here's an honest account of what cost that saved.

| Left out | What real TCP does | Why we left it out |
|----------|--------------------|--------------------|
| **Retransmission timers** | resend after the timer expires when no ACK comes | a single polling flow, so we don't assume loss |
| **Congestion control** (slow start, AIMD) | slow the send rate when the network is congested | an internet-scale problem — outside a toy kernel |
| **Window / flow control** | send only as much as the receiver can handle | we exchange one segment at a time (window is fixed) |
| **Reordering buffers** | collect and reorder out-of-order segments | no retransmission and only one in-flight at a time, so reordering effectively never happens |

> **Common misconception fix**: *"If you remove all of that, isn't it not TCP anymore?"* — both right and wrong. What we implemented is the **core of TCP's wire format and state transitions** (sequence accounting + 3-way handshake + pseudo-header checksum); what we left out are *"the mechanisms that make reliability robust in real internet conditions."* The core works, but throw it as-is onto a real network with frequent packet loss and it stalls. That's why we honestly call it an *"educational minimal implementation."*

Put all of these together and TCP is **a topic as big as a kernel on its own**.
This post's goal was to feel by hand **"how reliability begins from sequence numbers and the handshake,"** and that this minimal implementation shows completely.
In the trade-off of **"understanding the essence ↔ production completeness"** we chose the essence.

## Wrap-up

The road from UDP to TCP was a shift from *"packet"* to *"stream,"* from *"fire and forget"* to *"number and confirm."* Stacking the core in one direction:

- **The problem TCP solves** — IP doesn't prevent loss, reordering, or duplication. TCP *numbers every byte* to guarantee delivery, ordering, and connection.
- **Sequence accounting** — two entries `(my seq, my ack)` track both streams. SYN and FIN consume one seq even with no data. In code this shows up as `myseq += 1` (SYN/FIN) and `myseq += n` (data).
- **The 3-way handshake** — *"announce+confirm"* both streams' ISNs, with the middle message doubling as an ACK, so it comes out to exactly three. We implemented the **passive open (server)**, waiting for a SYN and answering with a SYN-ACK (ISN=20000).
- **Segment + checksum** — a 20-byte header (ports, seq, ack, offset+flags, window, checksum) with the same pseudo-header checksum as Part 7's UDP (only proto 17→6).
- **hostfwd verification** — the full life `SYN → SYN-ACK → ACK → data → echo → FIN` worked in a single host↔guest round-trip.
- **Deliberately left out** — retransmission, congestion control, windows, reordering. We kept the core and deferred internet-scale robustness as a trade-off.

That two numbers, seq and ack, are the **starting point** of reliability on top of an untrustworthy network — that's the elegance of TCP (full reliability also needs timers, retransmission, windows, congestion control, and a state machine, but the seed of all that accounting is these two numbers).
Holding the seed of that elegance in hand through one handshake and one echo was the reward of this work.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

## References (Primary Sources First)

- [RFC 9293 — Transmission Control Protocol (TCP)](https://www.rfc-editor.org/rfc/rfc9293) — the current TCP standard; primary definition of sequence accounting, the 3-way handshake, the pseudo-header checksum, and state transitions
- [RFC 793 — Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc793) — the original TCP spec (obsoleted by 9293); the source for the rule that SYN/FIN consume a seq
- [RFC 768 — User Datagram Protocol](https://www.rfc-editor.org/rfc/rfc768) — the UDP spec; its pseudo-header checksum scheme is shared with TCP
- [RFC 1122 — Requirements for Internet Hosts](https://www.rfc-editor.org/rfc/rfc1122) — host implementation requirements (checksums, retransmission, etc.)
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — this kernel's reference
- [QEMU User Networking (SLIRP) / hostfwd](https://www.qemu.org/docs/master/system/devices/net.html) — host→guest port forwarding via hostfwd
- Related: [Networking — virtio-net and a mini stack](/blog/hobby/hobby-kernel-06-networking) — the up-to-UDP stack this post rides on
