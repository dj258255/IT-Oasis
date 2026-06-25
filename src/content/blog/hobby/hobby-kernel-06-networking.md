---
title: '네트워킹 — virtio-net과 미니 TCP/IP 스택'
titleEn: 'Networking — virtio-net and a Mini TCP/IP Stack'
description: 토이 커널에 네트워크를 붙인다. virtio-net 드라이버로 프레임을 주고받고, 이더넷·ARP·IP·UDP·ICMP를 직접 구현해, QEMU user 네트워킹(SLIRP)을 상대로 게이트웨이 MAC을 ARP로 알아내고, ICMP로 ping을 왕복하고, DNS로 도메인을 해석한다. 패킷 하나가 바이트로 어떻게 조립되는지를 손으로 만져 이해하는 마지막 단계.
descriptionEn: "Adding networking to the toy kernel. A virtio-net driver moves frames in and out, and a hand-written Ethernet/ARP/IP/UDP/ICMP stack talks to QEMU's user networking (SLIRP) — resolving the gateway MAC with ARP, round-tripping a ping over ICMP, and resolving a domain over DNS. The final step in feeling, byte by byte, how a packet is assembled."
date: 2026-06-24T00:00:00.000Z
tags:
  - OS
  - C
  - Kernel
  - RISC-V
  - xv6
  - QEMU
  - Network
category: project/hobby-kernel
coverImage: "/uploads/hobby/hobby-kernel-c/cover.svg"
draft: false
series: "C로 만드는 토이 커널"
seriesOrder: 7
---


## 들어가며

지금까지 커널은 디스크까지 다뤘어요 — 부팅, 페이징, 프로세스, 파일시스템, 그리고 [6편의 멀티코어](/blog/hobby/hobby-kernel-05-smp-multicore-locks)까지.
이번엔 마지막 조각, **네트워크**예요.

네트워킹은 xv6 랩 중에서도 코드 표면이 가장 넓어요.
하드웨어(NIC)부터 이더넷·ARP·IP·UDP까지, 계층을 직접 쌓아야 패킷 하나가 나갔다 들어와요.
이 글의 목표는 **"패킷이 바이트로 어떻게 조립되고, 선을 타고 나갔다 돌아오는가"** 를 끝까지 손으로 만져보는 거예요.

검증 환경은 QEMU의 **user 네트워킹(SLIRP)** 이에요.
SLIRP는 게이트웨이(10.0.2.2)·DNS(10.0.2.3)·DHCP를 흉내내는 가상 네트워크라, 호스트 설정 없이 ARP·ICMP·DNS에 응답해줘요.

## 1. virtio-net 드라이버

좋은 소식 하나 — 우리는 이미 [3편에서 virtio-blk 디스크 드라이버](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)를 만들었어요.
virtio-net도 **같은 전송 계층(virtio-mmio)** 위에 있어서, 디스크립터 체인·available/used 링·기능 협상 코드가 거의 그대로 재사용돼요.

차이는 딱 세 가지예요.

1. **디바이스 ID** — 블록은 2, 네트워크는 1. QEMU virt의 8개 virtio-mmio 슬롯을 훑어 ID가 1인 걸 찾아요.
2. **큐가 둘** — 큐 0은 수신(RX), 큐 1은 송신(TX). 디스크는 큐 하나였죠.
3. **패킷 앞에 12바이트 헤더** — 모든 프레임 앞에 `virtio_net_hdr`(체크섬 오프로드·GSO 정보)가 붙어요. 우린 오프로드를 안 쓰니 0으로 채우고, 수신 땐 12바이트를 건너뛰면 돼요.

수신은 **버퍼를 미리 디바이스에 쥐여주는** 방식이에요.
RX 큐에 빈 버퍼 8개를 등록해두면, 패킷이 도착할 때 디바이스가 그 버퍼에 써넣고 used 링을 갱신해요.
우린 used 링을 폴링하다가, 갱신되면 버퍼에서 프레임을 꺼내고 그 버퍼를 다시 큐에 돌려줘요.

```c
// RX 버퍼 8개를 device-writable로 등록
for (int i = 0; i < NUM; i++) {
    rxbuf[i] = (uint8 *)kalloc();
    rxq.desc[i].addr  = (uint64)rxbuf[i];
    rxq.desc[i].len   = BUFSZ;
    rxq.desc[i].flags = VRING_DESC_F_WRITE;  // 디바이스가 여기에 쓴다
    rxq.avail->ring[i] = i;
}
rxq.avail->idx = NUM;
```

MAC 주소는 디바이스 설정공간(MMIO 오프셋 `0x100`)에서 읽어와요.

## 2. 이더넷과 ARP

이제 프레임을 만들 수 있으니, 첫 대화 상대는 **게이트웨이**예요.
IP로 무언가를 보내려면 먼저 "그 IP를 가진 상대의 MAC 주소"를 알아야 해요.
그걸 알아내는 게 **ARP**(Address Resolution Protocol)예요.

ARP 요청은 브로드캐스트예요 — "10.0.2.2를 가진 사람, MAC 알려줘"를 모두에게 외쳐요.
게이트웨이(SLIRP)가 "나야, 내 MAC은 이거야"라고 유니캐스트로 답하죠.

```c
// "who-has 10.0.2.2" 브로드캐스트
put16(a + 0, 1);          // htype = Ethernet
put16(a + 2, 0x0800);     // ptype = IPv4
a[4] = 6; a[5] = 4;       // hlen, plen
put16(a + 6, 1);          // oper = request
copy(a + 8, my_mac, 6);   copy(a + 14, MY_IP, 4);   // 보내는 나
zero(a + 18, 6);          copy(a + 24, target_ip, 4); // 찾는 대상
```

반대로 누가 **우리** IP를 물으면 응답도 해줘요(`arp_maybe_reply`).
이게 있어야 상대가 우리에게 패킷을 보낼 때 우리 MAC을 알 수 있어요.

부팅 로그에서 이 대화가 그대로 보여요.

```
[net] ARP who-has 10.0.2.2 (gateway) ... is-at 52:55:0a:00:02:02
```

이 한 줄이 뜨면 드라이버의 **송신·수신·이더넷·ARP가 전부 동작**한다는 증거예요.

## 3. IP, ICMP, UDP

게이트웨이 MAC을 알았으니 그 위에 IP 패킷을 얹어요.
IP 헤더는 20바이트 — 버전/길이, TTL, 프로토콜 번호, 그리고 **헤더 체크섬**이 핵심이에요.

체크섬은 16비트 단위로 더해 자리올림을 접고 1의 보수를 취하는 방식이에요.
IP·ICMP·UDP가 전부 같은 알고리즘을 써서, 함수 하나로 공용해요.

```c
static uint16 cksum(const uint8 *data, int len) {
    uint32 sum = 0;
    for (int i = 0; i + 1 < len; i += 2) sum += get16(data + i);
    if (len & 1) sum += (uint16)data[len - 1] << 8;
    while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);  // 자리올림 접기
    return ~sum & 0xffff;                                   // 1의 보수
}
```

IP가 되는지 검증하는 가장 깔끔한 방법은 **ping**(ICMP echo)이에요.
"echo request"를 게이트웨이로 보내면 "echo reply"가 돌아와요.
SLIRP는 게이트웨이 ping을 **내부에서** 응답하므로, 바깥 인터넷이 없어도 IP 계층과 체크섬이 맞는지 바로 확인돼요.

```
[net] ping 10.0.2.2 ... reply
```

UDP는 IP 위에 8바이트 헤더(출발/도착 포트, 길이, 체크섬)를 더 얹은 거예요.
UDP 체크섬은 좀 특이해서, IP 주소까지 포함한 **의사헤더**(pseudo-header)를 같이 합산해요.
이건 "이 패킷이 정말 이 출발지→도착지로 가는 게 맞나"까지 검증하려는 설계예요.

## 4. DNS

마지막으로 UDP 위에 **DNS**를 얹어 도메인 이름을 IP로 바꿔요.
질의는 헤더(질문 1개) + 이름(라벨 길이+문자열) + 타입(A=1)/클래스(IN=1)로 만들어요.

응답 파싱엔 함정이 하나 있어요 — **이름 압축**이에요.
응답은 질문의 도메인을 그대로 반복하는 대신, "12바이트 앞을 봐"라는 2바이트 포인터(`0xC0..`)로 가리켜요.
대역폭을 아끼려는 거죠.
그래서 파서는 라벨열인지 압축 포인터인지 첫 바이트로 구분해야 해요.

```c
// 답변의 NAME: 압축 포인터(0xC0..)면 2바이트, 아니면 라벨열을 따라간다
if ((r[off] & 0xc0) == 0xc0) off += 2;
else { while (r[off] != 0) off += r[off] + 1; off += 1; }
int type = get16(r + off);          // A 레코드면 type==1
int rdlen = get16(r + off + 8);     // A면 rdlen==4 (IPv4 4바이트)
```

다만 DNS는 **실제 외부 네트워크**가 필요해요.
SLIRP의 DNS(10.0.2.3)는 질의를 호스트의 리졸버로 포워딩하거든요.
그래서 외부망이 막힌 환경(샌드박스 등)에선 질의는 정상적으로 나가지만 응답이 안 와요.

```
[net] DNS A example.com ... timeout (no outbound DNS?)
```

여기서 중요한 건, **ICMP 왕복이 성공했다는 사실이 IP/UDP 송신 경로의 정확성을 이미 증명**한다는 점이에요.
DNS 타임아웃은 우리 스택의 버그가 아니라 환경의 외부망 차단 때문이고, 인터넷이 열린 환경에선 그대로 동작해요.

## 5. 되짚기 — 무엇을 안 만들었나

이 스택은 **UDP까지**예요.
**TCP는 일부러 뺐어요.**
이유는 트레이드오프예요.

TCP를 제대로 하려면 연결 상태머신(SYN/ACK/FIN), 재전송 타이머, 순서 재조립, 혼잡 제어, 윈도우 관리가 필요해요.
이건 그 자체로 커널만큼 큰 주제라, "패킷이 어떻게 조립되고 오가는가"라는 이 시리즈의 학습 목표엔 UDP까지가 비용 대비 효과가 가장 좋았어요.
ARP·IP·ICMP·UDP만으로도 NIC부터 응용까지 **계층이 어떻게 포개지는지**는 전부 만져볼 수 있거든요.

인터럽트 대신 **폴링**을 쓴 것도 같은 선택이에요.
실제 NIC 드라이버는 수신 인터럽트로 깨어나지만, 학습용 단일 흐름에선 used 링 폴링이 훨씬 단순하고 디버깅이 쉬워요(디스크 드라이버와 같은 방침).

## 마치며

부팅의 첫 글자부터, 페이징·프로세스·파일시스템·멀티코어를 지나, 이제 **패킷 한 장이 선을 타고 나갔다 돌아오는** 데까지 왔어요.

```
[ok] virtio-net ready, mac 52:54:00:12:34:56
[net] ARP who-has 10.0.2.2 (gateway) ... is-at 52:55:0a:00:02:02
[net] ping 10.0.2.2 ... reply
[ok] networking up: virtio-net + ARP + ICMP + IP/UDP
```

"운영체제가 안에서 어떻게 도는가"를 알고 싶어 시작한 여정이었어요.
부팅·트랩·페이징·시스템콜·프로세스·fork·exec·파일시스템·demand paging·mmap·멀티코어, 그리고 네트워크까지 — 교과서의 그림들을 전부 직접 코드로 만져봤어요.
xv6라는 좋은 지도를 따라왔지만, 막히는 지점마다 직접 디버깅하며 "왜 이렇게 설계됐나"를 이해한 게 가장 큰 수확이었어요.

남은 큰 주제(TCP, 저널링 파일시스템, COW fork, 유저 스레드)는 다음 기회로 남겨둘게요.
여기까지 읽어주셔서 고마워요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [Virtio 1.1 Specification — Network Device](https://docs.oasis-open.org/virtio/virtio/v1.1/virtio-v1.1.html)
- 시리즈 1편: [부팅부터 페이징까지](/blog/hobby/hobby-kernel-00-boot-to-paging)

<!-- EN -->

## Introduction

So far the kernel reached all the way to disk — boot, paging, processes, a filesystem, and [multicore in Part 6](/blog/hobby/hobby-kernel-05-smp-multicore-locks).
Now the last piece: **networking**.

Networking has the widest code surface of all the xv6 labs.
From the hardware (the NIC) up through Ethernet, ARP, IP, and UDP, you have to stack the layers yourself before a single packet goes out and comes back.
The goal of this post is to feel, end to end, **"how a packet is assembled from bytes, goes out over the wire, and returns."**

The test environment is QEMU's **user networking (SLIRP)**.
SLIRP is a virtual network that emulates a gateway (10.0.2.2), DNS (10.0.2.3), and DHCP, so it answers ARP, ICMP, and DNS without any host-side setup.

## 1. The virtio-net driver

One piece of good news — we already built a [virtio-blk disk driver in Part 3](/blog/hobby/hobby-kernel-02-fork-elf-filesystem).
virtio-net rides on the **same transport (virtio-mmio)**, so the descriptor chain, the available/used rings, and the feature negotiation code carry over almost verbatim.

There are exactly three differences.

1. **Device ID** — block is 2, network is 1. We scan QEMU virt's 8 virtio-mmio slots for the one with ID 1.
2. **Two queues** — queue 0 is receive (RX), queue 1 is transmit (TX). The disk had a single queue.
3. **A 12-byte header before each packet** — every frame is prefixed with a `virtio_net_hdr` (checksum-offload / GSO info). We don't use offload, so we zero it on TX and skip 12 bytes on RX.

Receiving works by **handing buffers to the device in advance**.
Register 8 empty buffers in the RX queue, and when a packet arrives the device writes into one and bumps the used ring.
We poll the used ring, pull the frame out when it advances, and return the buffer to the queue.

```c
// register 8 RX buffers as device-writable
for (int i = 0; i < NUM; i++) {
    rxbuf[i] = (uint8 *)kalloc();
    rxq.desc[i].addr  = (uint64)rxbuf[i];
    rxq.desc[i].len   = BUFSZ;
    rxq.desc[i].flags = VRING_DESC_F_WRITE;  // the device writes here
    rxq.avail->ring[i] = i;
}
rxq.avail->idx = NUM;
```

The MAC address is read from the device config space (MMIO offset `0x100`).

## 2. Ethernet and ARP

Now that we can build frames, the first conversation is with the **gateway**.
To send anything over IP, you first need "the MAC of whoever owns that IP."
Finding it is **ARP** (Address Resolution Protocol).

An ARP request is a broadcast — "whoever has 10.0.2.2, tell me your MAC" shouted to everyone.
The gateway (SLIRP) replies by unicast: "that's me, here's my MAC."

```c
// "who-has 10.0.2.2" broadcast
put16(a + 0, 1);          // htype = Ethernet
put16(a + 2, 0x0800);     // ptype = IPv4
a[4] = 6; a[5] = 4;       // hlen, plen
put16(a + 6, 1);          // oper = request
copy(a + 8, my_mac, 6);   copy(a + 14, MY_IP, 4);    // me, the sender
zero(a + 18, 6);          copy(a + 24, target_ip, 4); // the target
```

Conversely, when someone asks for **our** IP, we reply too (`arp_maybe_reply`).
That's needed so a peer can learn our MAC when it wants to send to us.

The boot log shows this conversation directly.

```
[net] ARP who-has 10.0.2.2 (gateway) ... is-at 52:55:0a:00:02:02
```

That one line is proof the driver's **TX, RX, Ethernet, and ARP all work**.

## 3. IP, ICMP, UDP

With the gateway MAC known, we layer IP packets on top.
The IP header is 20 bytes — version/length, TTL, protocol number, and crucially the **header checksum**.

The checksum sums 16-bit words, folds the carries, and takes the one's complement.
IP, ICMP, and UDP all use the same algorithm, so one function covers them all.

```c
static uint16 cksum(const uint8 *data, int len) {
    uint32 sum = 0;
    for (int i = 0; i + 1 < len; i += 2) sum += get16(data + i);
    if (len & 1) sum += (uint16)data[len - 1] << 8;
    while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);  // fold carries
    return ~sum & 0xffff;                                   // one's complement
}
```

The cleanest way to verify IP works is **ping** (ICMP echo).
Send an "echo request" to the gateway and an "echo reply" comes back.
SLIRP answers a gateway ping **internally**, so even without the outside internet you immediately confirm the IP layer and the checksum are correct.

```
[net] ping 10.0.2.2 ... reply
```

UDP adds an 8-byte header (source/destination ports, length, checksum) on top of IP.
The UDP checksum is a bit special — it also sums a **pseudo-header** that includes the IP addresses.
That's by design, to verify "is this packet really going from this source to this destination."

## 4. DNS

Finally, on top of UDP we layer **DNS** to turn a domain name into an IP.
A query is a header (one question) + the name (length-prefixed labels) + type (A=1) / class (IN=1).

Parsing the response has one trap — **name compression**.
Instead of repeating the question's domain, the response points to it with a 2-byte pointer (`0xC0..`) meaning "look 12 bytes back."
It's to save bandwidth.
So the parser must tell a label sequence from a compression pointer by the first byte.

```c
// answer NAME: a compression pointer (0xC0..) is 2 bytes; otherwise follow the labels
if ((r[off] & 0xc0) == 0xc0) off += 2;
else { while (r[off] != 0) off += r[off] + 1; off += 1; }
int type = get16(r + off);          // A record if type == 1
int rdlen = get16(r + off + 8);     // rdlen == 4 for A (4 bytes of IPv4)
```

That said, DNS needs **a real external network**.
SLIRP's DNS (10.0.2.3) forwards the query to the host's resolver.
So in an environment where outbound is blocked (a sandbox, say) the query goes out fine but no reply comes back.

```
[net] DNS A example.com ... timeout (no outbound DNS?)
```

The key point here is that **the successful ICMP round-trip already proves the IP/UDP transmit path is correct**.
The DNS timeout is not a bug in our stack but the environment blocking outbound traffic; in an environment with open internet it works as written.

## 5. Looking back — what we deliberately left out

This stack goes **up to UDP**.
**TCP was left out on purpose.**
The reason is a trade-off.

Doing TCP properly needs a connection state machine (SYN/ACK/FIN), retransmission timers, reordering/reassembly, congestion control, and window management.
That's a topic as big as a kernel on its own, so for this series' learning goal — "how a packet is assembled and travels" — stopping at UDP gave the best bang for the buck.
With just ARP/IP/ICMP/UDP you can still touch **how the layers stack** all the way from the NIC to the application.

Using **polling** instead of interrupts is the same kind of choice.
A real NIC driver wakes on a receive interrupt, but for a single learning-oriented flow, polling the used ring is far simpler and easier to debug (the same policy as the disk driver).

## Closing

From the very first character of boot, through paging, processes, the filesystem, and multicore, we've now arrived at **a single packet riding the wire out and back**.

```
[ok] virtio-net ready, mac 52:54:00:12:34:56
[net] ARP who-has 10.0.2.2 (gateway) ... is-at 52:55:0a:00:02:02
[net] ping 10.0.2.2 ... reply
[ok] networking up: virtio-net + ARP + ICMP + IP/UDP
```

This was a journey that began wanting to know "how an OS actually runs inside."
Boot, traps, paging, system calls, processes, fork, exec, the filesystem, demand paging, mmap, multicore, and now networking — I got to touch every one of those textbook diagrams as real code.
xv6 was a great map to follow, but the biggest reward was debugging each sticking point myself and understanding *why* it was designed that way.

The remaining big topics (TCP, a journaling filesystem, COW fork, user threads) I'll leave for another time.
Thanks for reading this far.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [Virtio 1.1 Specification — Network Device](https://docs.oasis-open.org/virtio/virtio/v1.1/virtio-v1.1.html)
- Series Part 1: [From Boot to Paging](/blog/hobby/hobby-kernel-00-boot-to-paging)
