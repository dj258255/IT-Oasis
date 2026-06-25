---
title: 'TCP — 신뢰성은 번호 매기기에서 온다'
titleEn: 'TCP — Reliability Comes from Numbering'
description: UDP는 패킷을 던지고 잊는다. TCP는 "내가 어디까지 보냈고 어디까지 받았나"를 시퀀스 번호로 추적해, 순서와 도착을 보장한다. net 스택 위에 TCP 세그먼트와 3-way 핸드셰이크를 올려, 수동 개방 서버를 만든다. 호스트가 접속해 보낸 데이터를 게스트 커널이 받아 에코하고, 그 왕복으로 핸드셰이크부터 종료까지를 검증한다. 그리고 우리가 일부러 빼놓은 것 — 재전송, 혼잡 제어, 윈도우 — 의 트레이드오프까지.
descriptionEn: "UDP fires and forgets. TCP tracks 'how far I've sent and how far I've received' with sequence numbers, guaranteeing order and delivery. On top of the net stack we add TCP segments and the 3-way handshake to build a passive-open server. A host connects and sends data, the guest kernel receives and echoes it, and that round-trip verifies everything from handshake to close. Plus the trade-offs of what we deliberately left out — retransmission, congestion control, windows."
date: 2026-06-30T00:00:00.000Z
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


## 들어가며

[7편에서 만든 네트워크 스택](/blog/hobby/hobby-kernel-06-networking)은 UDP까지였어요.
UDP는 단순해요 — 패킷 하나를 만들어 던지고 끝이에요.
도착했는지, 순서가 맞는지 신경 쓰지 않아요. **던지고 잊어버려요(fire and forget).**

TCP는 다른 약속을 해요.
"보낸 건 반드시, 보낸 순서대로 도착한다."
이 신뢰성은 마법이 아니라 **번호 매기기**에서 나와요.

이번 글은 그 번호 매기기 — 시퀀스 번호와 ACK — 로 TCP의 핵심인 **3-way 핸드셰이크**를 구현하고, 수동 개방 서버를 만들어 호스트와 실제로 데이터를 주고받아요.

## 1. 핵심 — 시퀀스 번호 회계

TCP의 신뢰성은 양방향 **장부**에서 나와요.

- **seq**(시퀀스 번호): "내가 보내는 이 바이트는 스트림의 몇 번째다."
- **ack**(확인 응답): "나는 여기까지 받았으니, 다음은 이 번호부터 보내라."

이 두 숫자로 양쪽이 "어디까지 보냈고 어디까지 받았나"를 추적해요.
빠진 게 있으면 ack가 안 올라가니 재전송하고, 순서가 뒤바뀌면 seq로 재정렬해요.
UDP엔 없는 이 장부가 신뢰성의 전부예요.

특이한 규칙 하나 — **SYN과 FIN은 데이터가 없어도 시퀀스 번호를 1 소비**해요.
연결의 시작과 끝도 "스트림의 한 지점"으로 세는 거죠.

## 2. 3-way 핸드셰이크

연결은 세 번의 인사로 시작해요.

```
클라이언트            서버
   |---- SYN(seq=x) ------>|     "x번부터 시작할게"
   |<-- SYN-ACK(seq=y, ----|     "좋아, 난 y번부터. x+1 기다릴게"
   |        ack=x+1)        |
   |---- ACK(ack=y+1) ---->|     "확인, 너의 y+1 기다릴게"
   |                        |
   |======= 연결 수립 =======|
```

왜 세 번일까요?
양쪽이 **각자의 시작 번호(ISN)를 상대에게 알리고, 상대가 받았음을 확인**해야 하기 때문이에요.
내 SYN(1,2번째 메시지)과 상대 SYN(2,3번째)이 각각 확인돼야 하니, 최소 세 번이 필요해요.

우리는 **수동 개방(서버)** 을 구현했어요.
서버는 SYN을 기다리다가, 받으면 자기 ISN을 담은 SYN-ACK로 답하고, 클라이언트의 ACK로 연결을 확정해요.

```c
// 1) SYN 대기
for (;;) {
    n = tcp_recv(myport, ...&fl...);
    if (fl & TH_SYN) break;         // SYN 도착
}
// 2) SYN-ACK (우리 ISN, SYN이 seq 1 소비)
tcp_send(..., myseq, cliseq + 1, TH_SYN | TH_ACK, 0, 0);
myseq += 1;
// 3) 이후 데이터 수신 → 에코 → FIN 종료
```

## 3. 세그먼트와 체크섬

TCP 세그먼트는 IP 위에 20바이트 헤더를 얹어요 — 포트, seq, ack, 플래그(SYN/ACK/FIN/PSH/RST), 윈도우, 체크섬.

체크섬은 [7편의 UDP](/blog/hobby/hobby-kernel-06-networking)와 같은 **의사헤더**(IP 주소 포함) 방식이에요.
"이 세그먼트가 정말 이 출발지→도착지로 가는 게 맞나"까지 검증하죠.
프로토콜 번호만 UDP(17)에서 TCP(6)로 바뀌어요.

```c
uint32 sum = 0;
sum += get16(MY_IP) + get16(MY_IP+2) + get16(dip) + get16(dip+2);  // 의사헤더
sum += IP_TCP + tcplen;
for (TCP 헤더+데이터 16비트씩) sum += ...;
put16(checksum, ~sum & 0xffff);
```

## 4. 눈으로 확인하기

검증은 QEMU의 **hostfwd**(호스트 포트 → 게스트 포트)로 했어요.
게스트 커널이 :5599에서 리스닝하고, 맥에서 그 포트로 접속해 데이터를 보내요.

게스트(커널) 쪽 로그:

```
[tcp] listening on :5599 (waiting for host connect) ...
SYN from 10.0.2.2                          ← 핸드셰이크 시작
[tcp] recv: hi from host over TCP          ← 호스트가 보낸 데이터 수신
[ok] tcp: accept + handshake + echo + close done
```

호스트 쪽:

```
host got echo: b'hi from host over TCP\n'   ← 게스트가 에코한 걸 받음
```

호스트가 보낸 바이트가 게스트 커널의 TCP 스택을 타고 들어와, 다시 에코로 돌아왔어요.
SYN → SYN-ACK → ACK → 데이터 → 에코 → FIN, 연결의 전 생애가 동작한 거예요.

## 5. 되짚기 — 일부러 빼놓은 것

우리 TCP는 **연결 하나, 한 번의 데이터 교환**까지예요.
진짜 TCP를 떠받치는 무거운 부분들은 일부러 뺐어요.

- **재전송 타이머**: ACK가 안 오면 다시 보내는 것. 우리는 폴링 한 흐름이라 손실을 가정하지 않았어요.
- **혼잡 제어**(슬로스타트, AIMD): 네트워크가 막히면 속도를 줄이는 것. 인터넷 규모의 문제라 토이 커널 범위 밖이에요.
- **윈도우/흐름 제어**: 받는 쪽이 감당할 만큼만 보내는 것. 우리는 한 세그먼트씩 주고받아요.
- **재정렬 버퍼**: 순서 뒤바뀐 세그먼트를 모으는 것.

이걸 다 합치면 TCP는 그 자체로 커널만큼 큰 주제예요.
이번 글의 목표는 **"신뢰성이 시퀀스 번호와 핸드셰이크에서 어떻게 시작되나"** 를 손으로 만져보는 거였고, 거기까진 이 최소 구현으로 완전히 보여요.
**"본질의 이해 ↔ 프로덕션 완전성"** 에서 본질을 택한 거예요.

## 마치며

UDP에서 TCP로 오는 길은 "패킷"에서 "스트림"으로, "던지고 잊기"에서 "번호 매기고 확인하기"로의 전환이었어요.
seq와 ack라는 두 숫자가, 못 믿을 네트워크 위에 믿을 수 있는 바이트 스트림을 세운다는 게 TCP의 우아함이에요.
그 우아함의 씨앗을 핸드셰이크 한 번으로 확인한 게 이번 작업이었어요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RFC 793 — Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc793)
- 관련 글: [네트워킹 — virtio-net과 미니 스택](/blog/hobby/hobby-kernel-06-networking)

<!-- EN -->

## Introduction

The [network stack from Part 7](/blog/hobby/hobby-kernel-06-networking) went up to UDP.
UDP is simple — build one packet, fire it off, done.
It doesn't care whether it arrived or whether the order is right. It **fires and forgets**.

TCP makes a different promise.
"What you send arrives, and arrives in the order you sent it."
This reliability isn't magic — it comes from **numbering**.

This post implements that numbering — sequence numbers and ACKs — to build TCP's core, the **3-way handshake**, and a passive-open server that actually exchanges data with the host.

## 1. The core — sequence number accounting

TCP's reliability comes from a two-way **ledger**.

- **seq** (sequence number): "this byte I'm sending is the Nth in the stream."
- **ack** (acknowledgment): "I've received up to here, so send from this number next."

With these two numbers, both sides track "how far I've sent and how far I've received."
If something is missing, the ack doesn't advance, so you retransmit; if the order is scrambled, you reorder by seq.
This ledger, absent in UDP, is the whole of reliability.

One peculiar rule — **SYN and FIN consume one sequence number even with no data**.
The start and end of a connection are also counted as "a point in the stream."

## 2. The 3-way handshake

A connection begins with three greetings.

```
client                  server
   |---- SYN(seq=x) ------>|     "I'll start from x"
   |<-- SYN-ACK(seq=y, ----|     "ok, I'm from y. I'll wait for x+1"
   |        ack=x+1)        |
   |---- ACK(ack=y+1) ---->|     "got it, I'll wait for your y+1"
   |                        |
   |==== connection up =====|
```

Why three?
Because both sides must **announce their own initial number (ISN) to the other and have the other confirm receipt**.
My SYN (messages 1,2) and the peer's SYN (messages 2,3) each need confirming, so a minimum of three is required.

We implemented the **passive open (server)** side.
The server waits for a SYN, and on receiving one replies with a SYN-ACK carrying its own ISN, then confirms the connection with the client's ACK.

```c
// 1) wait for SYN
for (;;) {
    n = tcp_recv(myport, ...&fl...);
    if (fl & TH_SYN) break;         // SYN arrived
}
// 2) SYN-ACK (our ISN, SYN consumes 1 seq)
tcp_send(..., myseq, cliseq + 1, TH_SYN | TH_ACK, 0, 0);
myseq += 1;
// 3) then receive data → echo → FIN close
```

## 3. Segments and the checksum

A TCP segment puts a 20-byte header on top of IP — ports, seq, ack, flags (SYN/ACK/FIN/PSH/RST), window, checksum.

The checksum uses the same **pseudo-header** (including the IP addresses) as [UDP in Part 7](/blog/hobby/hobby-kernel-06-networking).
It verifies "is this segment really going from this source to this destination."
Only the protocol number changes, from UDP (17) to TCP (6).

```c
uint32 sum = 0;
sum += get16(MY_IP) + get16(MY_IP+2) + get16(dip) + get16(dip+2);  // pseudo-header
sum += IP_TCP + tcplen;
for (each 16 bits of TCP header+data) sum += ...;
put16(checksum, ~sum & 0xffff);
```

## 4. Seeing it with your own eyes

Verification used QEMU's **hostfwd** (host port → guest port).
The guest kernel listens on :5599, and the Mac connects to that port and sends data.

The guest (kernel) side log:

```
[tcp] listening on :5599 (waiting for host connect) ...
SYN from 10.0.2.2                          ← handshake begins
[tcp] recv: hi from host over TCP          ← received the data the host sent
[ok] tcp: accept + handshake + echo + close done
```

The host side:

```
host got echo: b'hi from host over TCP\n'   ← got back what the guest echoed
```

The bytes the host sent rode in through the guest kernel's TCP stack and returned as an echo.
SYN → SYN-ACK → ACK → data → echo → FIN, the entire life of a connection worked.

## 5. Looking back — what we deliberately left out

Our TCP goes as far as **one connection, one data exchange**.
The heavy parts that hold up real TCP we left out on purpose.

- **Retransmission timers**: resending when no ACK comes. With our single polling flow, we don't assume loss.
- **Congestion control** (slow start, AIMD): slowing down when the network is congested. An internet-scale problem, outside a toy kernel.
- **Window / flow control**: sending only as much as the receiver can handle. We exchange one segment at a time.
- **Reordering buffers**: collecting out-of-order segments.

Put all of these together and TCP is a topic as big as a kernel on its own.
This post's goal was to feel by hand **"how reliability begins from sequence numbers and the handshake,"** and that this minimal implementation shows completely.
Between **"understanding the essence ↔ production completeness"** we chose the essence.

## Closing

The road from UDP to TCP was a shift from "packet" to "stream," from "fire and forget" to "number and confirm."
That two numbers, seq and ack, build a trustworthy byte stream on top of an untrustworthy network — that's the elegance of TCP.
Confirming the seed of that elegance with a single handshake was the reward of this work.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RFC 793 — Transmission Control Protocol](https://www.rfc-editor.org/rfc/rfc793)
- Related: [Networking — virtio-net and a mini stack](/blog/hobby/hobby-kernel-06-networking)
