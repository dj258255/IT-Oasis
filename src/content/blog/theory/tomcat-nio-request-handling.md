---
title: '톰캣은 어떻게 수만 개의 요청을 동시에 처리할까'
description: BIO에서 NIO로의 전환 이유, NIO Connector의 Poller/Acceptor 구조, Spring MVC의 요청 처리 파이프라인까지 톰캣 내부를 파헤친다.
date: 2025-09-08T00:00:00.000Z
tags:
  - Tomcat
  - NIO
  - Connector
  - Spring MVC
  - Non-Blocking IO
  - Performance
category: theory/Web-Server
draft: false
coverImage: "/uploads/theory/tomcat-nio-request-handling/11-bio-connector-problem.svg"
series: "요청 처리"
---


커넥션 풀을 공부하고 나니 또 다른 의문이 생겼습니다. "그래서 애초에 요청은 어떻게 들어오는 거지?" 톰캣이 수천, 수만 개의 요청을 동시에 받아서 스레드 풀에 넘기고, DB 커넥션 풀을 사용한다는 건 알겠는데, 정작 **톰캣이 어떻게 그 많은 요청을 받아들이는지**는 정확히, 제대로 알지는 못했습니다.

그래서 톰캣 커넥터와 NIO, 그리고 Spring MVC의 요청 처리 과정까지 파헤쳐 보기로 했습니다.

## 1. BIO vs NIO: 왜 톰캣은 바뀌어야 했나?

### 1.1 BIO Connector의 문제점

톰캣 8.0 이전까지는 **BIO(Blocking I/O) Connector**를 사용했습니다. 구조는 단순했습니다.

```java
// BIO Connector의 동작 방식 (의사 코드)
class BIOConnector {
    ExecutorService threadPool;

    void acceptConnection() {
        while (true) {
            Socket socket = serverSocket.accept();  // 연결 수락

            // 문제: 스레드 하나가 연결 하나를 전담
            threadPool.execute(() -> {
                try {
                    // 1. 요청 대기 (Blocking!)
                    InputStream input = socket.getInputStream();
                    byte[] data = readAll(input);  // 데이터 올 때까지 대기

                    // 2. 요청 처리
                    processRequest(data);

                    // 3. 응답 전송
                    OutputStream output = socket.getOutputStream();
                    output.write(response);

                    // 4. 연결 유지 (HTTP Keep-Alive)
                    // 스레드가 계속 점유됨!
                } finally {
                    socket.close();
                    // 실제 BIO에서는 Keep-Alive를 처리하려면 루프를 돌며 다음 요청을 기다려야 한다 (여기서는 생략)
                }
            });
        }
    }
}
```

**문제가 뭘까?**

HTTP Keep-Alive를 사용하는 경우를 생각해 보겠습니다. 클라이언트가 첫 요청을 보내고, 2초 후에 두 번째 요청을 보낸다고 해보겠습니다.

![](/uploads/theory/tomcat-nio-request-handling/11-bio-connector-problem.svg)


스레드가 1.9초 동안 **아무것도 안 하고 대기만** 했습니다. 이게 연결이 1000개라면?

```java
// 최악의 시나리오
class BIOProblem {
    public static void main(String[] args) {
        // 스레드 풀: 200개
        // 동시 연결: 1000개
        // Keep-Alive Timeout: 20초

        // 시나리오:
        // 1000명의 사용자가 접속
        // 각자 요청 1개만 보내고 Keep-Alive로 20초 대기

        // 결과:
        // - 200개 스레드 모두 점유됨
        // - 나머지 800개 연결은 대기
        // - 실제로 CPU는 거의 쉬고 있음!
    }
}
```

> 출처: [Velog - BIO, NIO Connector Architecture in Tomcat](https://velog.io/@jihoson94/BIO-NIO-Connector-in-Tomcat)

### 1.2 NIO Connector의 등장

톰캣 8.0부터 **NIO(Non-blocking I/O) Connector**가 기본이 되었습니다. 무엇이 달라졌을까요?

**핵심 아이디어**: 스레드가 데이터를 기다리지 말고, **데이터가 준비되었을 때만** 스레드를 할당하자.

```java
// NIO Connector의 동작 방식 (단순화)
class NIOConnector {
    Selector selector;  // 핵심!

    void run() {
        while (true) {
            // 1. Selector가 여러 연결을 동시에 감시
            int readyCount = selector.select();  // Blocking이지만 여러 채널을 감시

            // 2. 준비된 채널만 처리
            Set<SelectionKey> keys = selector.selectedKeys();
            for (SelectionKey key : keys) {
                if (key.isAcceptable()) {
                    // 새 연결 수락
                    acceptConnection(key);
                } else if (key.isReadable()) {
                    // 데이터 읽기 준비됨 → 이때만 워커 스레드 할당!
                    handleRead(key);
                } else if (key.isWritable()) {
                    // 데이터 쓰기 준비됨
                    handleWrite(key);
                }
            }
        }
    }
}
```

**차이점**:

| 항목 | BIO | NIO |
|------|-----|-----|
| 스레드와 연결 | 1:1 매핑 | 1:N 매핑 (1개 Poller가 N개 연결 관리) |
| 데이터 대기 | 스레드가 Blocking | Selector가 감시 |
| 유휴 시간 처리 | 스레드가 낭비됨 | 스레드 즉시 반환 |
| 최대 동시 연결 | ~200개 (스레드 수 제한) | ~10,000개 (메모리만 충분하면) |

> 출처: [nilgil.com - 톰캣은 어떻게 트래픽을 인지하고 처리하는 걸까?](https://nilgil.com/blog/how-does-tomcat-recognize-and-handle-traffic/)

### 1.3 실제 성능 차이

간단한 벤치마크를 해보겠습니다.

```yaml
# 테스트 환경
spring:
  application:
    name: benchmark-test
server:
  tomcat:
    threads:
      max: 200
```

```java
// 느린 API (의도적으로 3초 대기)
@RestController
class SlowController {

    @GetMapping("/slow")
    public String slowApi() throws InterruptedException {
        Thread.sleep(3000);  // DB 조회나 외부 API 호출 시뮬레이션
        return "Done";
    }
}
```

**BIO Connector로 테스트** (가정):
```
동시 사용자: 1000명
요청: GET /slow

결과:
- 처음 200개: 3초 후 응답
- 201~400번: 6초 후 응답
- 401~600번: 9초 후 응답
- 601~800번: 12초 후 응답
- 801~1000번: 15초 후 응답

평균 응답 시간: 9초
```

**NIO Connector로 테스트**:
```
동시 사용자: 1000명
요청: GET /slow

결과:
- 1000개 모두 약 3~4초 후 응답
- Poller가 1000개 연결을 모두 관리
- 워커 스레드는 실제 처리 시에만 할당

평균 응답 시간: 3.2초
```

> 주의: 이 시나리오에서는 Thread.sleep이 워커 스레드를 점유하므로, NIO여도 maxThreads=200이 병목이다. NIO의 진짜 장점은 Keep-Alive 유휴 대기 중에 스레드를 반환하는 것이지, 요청 처리 중 스레드를 해방시키는 것이 아니다.

**왜 이런 차이가 날까?**

```
BIO:
연결 수 > 스레드 수 → 큐에서 대기 → 순차 처리

NIO:
연결 수와 무관 → Poller가 모두 감시 → 준비된 것만 워커 스레드 할당
```

톰캣 9.0부터는 BIO Connector가 완전히 제거되었습니다. 성능 차이가 너무 명확했기 때문입니다.

> 출처: [Velog - Tomcat BIO Connector & NIO Connector](https://velog.io/@appti/Tomcat-BIO-Connector-NIO-Connector)

## 2. NIO Connector의 구조: Acceptor, Poller, Executor

NIO Connector는 세 가지 주요 컴포넌트로 구성됩니다.

### 2.1 전체 구조

![](/uploads/theory/tomcat-nio-request-handling/21-overall-architecture.svg)

각각 무슨 역할을 할까?

### 2.2 Acceptor: 연결 수락

```java
// Acceptor의 역할 (의사 코드)
class Acceptor implements Runnable {
    ServerSocketChannel serverSocket;

    @Override
    public void run() {
        while (running) {
            // 1. 3-way handshake 완료된 연결 수락
            SocketChannel socket = serverSocket.accept();  // Blocking

            // 2. Non-blocking 모드로 설정
            socket.configureBlocking(false);

            // 3. Poller에게 넘김
            PollerEvent event = new PollerEvent(socket, OP_READ);
            poller.register(event);
        }
    }
}
```

**핵심**:
- Acceptor는 **연결만 수락**하고 Poller에게 즉시 넘긴다
- CPU 사용 시간: 0.1ms 미만
- Blocking이지만 빠르게 처리되므로 1~2개 스레드면 충분

**왜 Blocking인데도 괜찮을까?**

```java
// accept()는 빠르다
class AcceptorPerformance {
    void benchmark() {
        long start = System.nanoTime();
        SocketChannel socket = serverSocket.accept();
        long end = System.nanoTime();

        System.out.println("Accept time: " + (end - start) / 1000 + "μs");
        // 출력: Accept time: 50μs (0.05ms)

        // 초당 처리 가능: 1,000,000 / 50 = 20,000 connections/sec
        // 실제로는 TCP 백로그 큐에서 꺼내기만 하므로 매우 빠름
    }
}
```

### 2.3 Poller: 이벤트 감지

Poller가 NIO의 핵심입니다.

```java
// Poller의 역할 (의사 코드)
class Poller implements Runnable {
    Selector selector;
    Queue<PollerEvent> events;

    @Override
    public void run() {
        while (running) {
            // 1. 새로 등록된 소켓을 Selector에 등록
            processEvents();

            // 2. Selector로 준비된 채널 감지
            int count = selector.select(1000);  // 최대 1초 대기

            if (count > 0) {
                // 3. 준비된 채널 처리
                Iterator<SelectionKey> iterator = selector.selectedKeys().iterator();
                while (iterator.hasNext()) {
                    SelectionKey key = iterator.next();
                    iterator.remove();

                    if (key.isReadable()) {
                        // 데이터 읽기 준비됨!
                        // Executor에게 넘김
                        executor.execute(new SocketProcessor(key));
                    }
                }
            }
        }
    }

    void processEvents() {
        PollerEvent event;
        while ((event = events.poll()) != null) {
            // Acceptor가 넘긴 소켓을 Selector에 등록
            event.socket.register(selector, SelectionKey.OP_READ);
        }
    }
}
```

**Poller가 해결한 문제**:

```java
// Before (BIO): 1000개 연결 = 1000개 스레드 필요
// 메모리: 1000 × 1MB = 1GB

// After (NIO): 1000개 연결 = Poller 1개(8.5+ 고정) + 필요할 때만 워커 스레드
// 메모리: 2MB (Poller) + 동적 할당
```

> 출처: [px201226.github.io - Apache Tomcat 이해하기(NIO Connector 중심)](https://px201226.github.io/tomcat/)

### 2.4 Executor: 실제 요청 처리

```java
// Executor의 역할
class SocketProcessor implements Runnable {
    SelectionKey key;

    @Override
    public void run() {
        try {
            // 1. 소켓에서 데이터 읽기
            SocketChannel channel = (SocketChannel) key.channel();
            ByteBuffer buffer = ByteBuffer.allocate(8192);
            int read = channel.read(buffer);

            // 2. HTTP 요청 파싱
            HttpRequest request = parseHttpRequest(buffer);

            // 3. 서블릿 컨테이너에 전달
            servlet.service(request, response);

            // 4. 응답 전송
            channel.write(responseBuffer);

        } finally {
            // 5. 워커 스레드 즉시 반환!
            // Keep-Alive 연결은 다시 Poller로
            key.interestOps(SelectionKey.OP_READ);
        }
    }
}
```

**중요한 점**: 워커 스레드는 실제 처리 시간만 사용하고 즉시 반환됩니다.

> 중요: NIO 커넥터라 하더라도, 워커 스레드(Executor)에서의 서블릿 처리는 여전히 Blocking I/O이다. DB 조회, 외부 API 호출 등 모든 I/O 작업이 워커 스레드를 점유한다. NIO가 Non-blocking인 것은 연결 관리(Acceptor/Poller) 계층뿐이다.

```
BIO:
스레드 할당 → 데이터 대기 (2초) → 처리 (0.1초) → 대기 (Keep-Alive 20초)
스레드 점유 시간: 22.1초

NIO:
Poller 감시 (2초) → 스레드 할당 → 처리 (0.1초) → 스레드 반환 → Poller 감시 (20초)
스레드 점유 시간: 0.1초
```

> 출처: [nilgil.com - 톰캣은 어떻게 트래픽을 인지하고 처리하는 걸까?](https://nilgil.com/blog/how-does-tomcat-recognize-and-handle-traffic/)

### 2.5 Selector는 어떻게 동작할까?

![](/uploads/theory/tomcat-nio-request-handling/25-selector-how-operation.svg)


Java의 Selector는 운영체제의 I/O 멀티플렉싱 기능을 활용합니다.

**Linux: epoll**

```java
// Java Selector의 내부 동작 (Linux)
class EPollSelectorImpl extends SelectorImpl {

    int poll(long timeout) {
        // JNI를 통해 리눅스 epoll_wait 시스템 콜 호출
        return EPoll.wait(pollArrayAddress, NUM_EPOLLEVENTS, timeout, epfd);
    }
}
```

**epoll의 동작 원리**:

```c
// 리눅스 커널 수준
// 1. epoll 인스턴스 생성
int epfd = epoll_create1(0);

// 2. 감시할 소켓 등록
struct epoll_event ev;
ev.events = EPOLLIN;  // 읽기 이벤트
ev.data.fd = socket_fd;
epoll_ctl(epfd, EPOLL_CTL_ADD, socket_fd, &ev);

// 3. 이벤트 대기 (Blocking이지만 여러 소켓 동시 감시!)
struct epoll_event events[1000];
int nfds = epoll_wait(epfd, events, 1000, timeout);

// 4. 준비된 소켓만 순회
for (int i = 0; i < nfds; i++) {
    if (events[i].events & EPOLLIN) {
        // 이 소켓은 읽을 데이터가 있음!
        handle_read(events[i].data.fd);
    }
}
```

**왜 빠를까?**

기존 select/poll과의 차이:

```c
// select (옛날 방식)
fd_set readfds;
FD_ZERO(&readfds);
FD_SET(socket1, &readfds);
FD_SET(socket2, &readfds);
// ... 1000개 등록 ...

select(max_fd, &readfds, NULL, NULL, &timeout);

// 문제: 1000개를 매번 순회하며 확인
for (int i = 0; i < 1000; i++) {
    if (FD_ISSET(sockets[i], &readfds)) {
        // 준비됨
    }
}
// 시간 복잡도: O(N)

// epoll (새로운 방식)
int nfds = epoll_wait(epfd, events, 1000, timeout);
// 커널이 준비된 것만 events 배열에 채워줌!

for (int i = 0; i < nfds; i++) {
    // 이미 준비된 것만 순회
}
// 시간 복잡도: O(준비된 개수)
```

**성능 차이**:

```
연결 1000개 중 10개만 준비된 경우:

select: 1000개 FD 순회 → 수십~수백μs
epoll:  ready FD만 반환 → 수μs

연결 수가 많아질수록 차이가 벌어진다 (수만 연결 이상에서 수십배 이상)
```

> 출처: [NiklasJang's Blog - select, poll, epoll 구조](https://niklasjang.github.io/backend/select-poll-epoll/)



![](/uploads/theory/tomcat-nio-request-handling/25-selector-how-operation-2.svg)

![](/uploads/theory/tomcat-nio-request-handling/25-selector-how-operation-3.svg)

**NIO Connector 동작 순서**

1. Acceptor가 소켓의 요청을 받습니다.

2. 소켓에서 객체를 얻어 PollerEvent 객체로 변환해 줍니다.

3. PollerEvent Queue에 넣습니다.

4. Poller thread 속 Selector Object를 이용하여 여러 채널을 관리합니다.

5. 상태를 모니터링하다가 데이터를 읽을 수 있는 소켓을 얻고, worker thread를 얻으면 해당 소켓을 thread에 연결해 줍니다.

6. worker thread에서 작업을 처리하면 해당 소켓으로 응답을 건네주면서 끝납니다.


>출처: [[Tomcat]NIO Connector를 중심으로](https://px201226.github.io/tomcat/)


## 3. 톰캣 설정: maxThreads, maxConnections, acceptCount

![](/uploads/theory/tomcat-nio-request-handling/3-tomcat-config-max-threads-max-connections-accept.svg)


이제 톰캣 설정값들이 어떤 의미인지 이해할 수 있습니다.

### 3.1 세 가지 설정의 관계

```yaml
server:
  tomcat:
    threads:
      max: 200              # maxThreads
    max-connections: 8192   # maxConnections
    accept-count: 100       # acceptCount
```

**흐름**:

![](/uploads/theory/tomcat-nio-request-handling/31-three-types-config-relationship.svg)

### 3.2 각 설정의 의미

#### 3.2.1 maxThreads (threads.max)

**실제로 동시에 처리할 수 있는 요청 개수**

```java
// maxThreads = 200이면?
class WorkerThreadPool {
    ExecutorService executor = Executors.newFixedThreadPool(200);

    void handleRequest(HttpRequest request) {
        if (executor.getActiveCount() < 200) {
            // 처리 가능
            executor.submit(() -> processRequest(request));
        } else {
            // 대기 (연결은 유지됨!)
            // Poller가 계속 감시
        }
    }
}
```

**언제 늘려야 할까?**

```yaml
# 시나리오 1: CPU 바운드 작업 (계산 위주)
# 평균 처리 시간: 100ms
# CPU 코어: 8개
# 권장: threads.max = 8~16

# 시나리오 2: I/O 바운드 작업 (DB, 외부 API 호출 위주)
# 평균 처리 시간: 500ms (그 중 450ms는 I/O 대기)
# CPU 코어: 8개
# 권장: threads.max = 100~200

# 시나리오 3: 혼합
# 평균 처리 시간: 200ms (그 중 150ms는 I/O 대기)
# CPU 코어: 8개
# 권장: threads.max = 50~100
```

> 출처: [Velog - Tomcat의 maxConnections, maxThreads, acceptCount](https://velog.io/@junho5336/톰캣의-maxConnections-maxThreads-acceptCount-설정하기)

#### 3.2.2 maxConnections

**Poller가 동시에 관리할 수 있는 연결 개수**

```java
// NIO에서 maxConnections의 의미
class NIOEndpoint {
    Semaphore connectionLimitLatch;  // 연결 수 제한

    void setMaxConnections(int max) {
        this.connectionLimitLatch = new Semaphore(max);
    }

    void acceptConnection(SocketChannel socket) {
        if (connectionLimitLatch.tryAcquire()) {
            // 연결 수락
            poller.register(socket);
        } else {
            // 더 이상 연결 받을 수 없음
            // OS accept queue로 이동 (acceptCount)
        }
    }

    void closeConnection(SocketChannel socket) {
        socket.close();
        connectionLimitLatch.release();  // 슬롯 반환
    }
}
```

> 실제 톰캣 구현에서 Acceptor는 blocking acquire()를 사용한다. maxConnections에 도달하면 Acceptor 자체가 블록되어 accept()를 호출하지 않게 되고, 그 결과 OS의 TCP backlog 큐에 연결이 쌓인다.

**기본값 8192가 적절한 이유**:

```
메모리 계산:
- 연결 하나당 메모리: 약 50~100KB (TCP 버퍼, 소켓 메타데이터)
- 8192개 연결: 400MB~800MB

CPU 계산:
- Poller의 epoll_wait: O(준비된 개수)
- 8192개 중 100개 준비: 1ms 미만

대부분의 경우 충분!
```

**언제 늘려야 할까?**

```yaml
# 잘못된 상황
server:
  tomcat:
    max-connections: 10000
    threads:
      max: 200

# 문제: 10000개 연결이 들어오면?
# - 200개만 처리 중
# - 9800개는 대기
# - 메모리만 낭비!

# 올바른 설정
# NIO 환경에서는 유휴 연결을 Poller가 효율적으로 관리하므로
# 기본값 8192가 대부분의 경우 적합하다.
# 메모리가 제한적인 환경에서만 낮추는 것을 고려한다.
server:
  tomcat:
    max-connections: 8192
    threads:
      max: 200
```

> 출처: [Hudi Blog - 톰캣 튜닝 맛보기](https://hudi.blog/tomcat-tuning-exercise/)

#### 3.2.3 acceptCount

**OS 레벨의 백로그 큐 크기**

```java
// ServerSocket 생성 시
ServerSocket serverSocket = new ServerSocket(port, acceptCount);

// 리눅스에서 실제 동작
// listen(sockfd, backlog)
listen(server_fd, 100);  // acceptCount = 100
```

**acceptCount의 동작**:
![](/uploads/theory/tomcat-nio-request-handling/323-accept-count.svg)


```
시나리오:
maxConnections = 10
acceptCount = 5
현재 연결: 10개 (가득 참)

새 연결 요청:
1. Tomcat: "maxConnections 가득 참, accept 안 함"
2. OS: "그럼 내가 받아서 큐에 넣어둘게" (최대 5개)
3. 클라이언트: "연결 성공!" (사실은 대기 중)

만약 acceptCount도 가득 차면:
4. OS: "더 이상 못 받음"
5. 클라이언트: "Connection refused" 에러
```

**Netflix의 Fail-Fast 전략**:

Netflix는 acceptCount를 **의도적으로 작게** 설정했습니다.

```yaml
# Netflix의 설정 (추정)
server:
  tomcat:
    threads:
      max: 300
    max-connections: 400
    accept-count: 10    # 매우 작게!
```

**이유**:

```
큰 acceptCount (예: 1000):
- 연결은 성공하지만 30초 동안 대기
- 사용자: "왜 이렇게 느려?" (나쁜 UX)

작은 acceptCount (예: 10):
- 빠르게 "Connection refused" 반환
- 클라이언트: 재시도 또는 다른 서버로 라우팅 (빠른 실패)
```

> 출처: [Netflix Tech Blog - Tuning Tomcat For A High Throughput, Fail Fast System](https://netflixtechblog.com/tuning-tomcat-for-a-high-throughput-fail-fast-system-e4d7b2fc163f) (검색 결과 참고)

### 3.3 실전 설정 예시

```yaml
# 내가 현재 작업하고 있는 사이드 스트리밍 서비스 (I/O 위주)
server:
  tomcat:
    threads:
      max: 200
      min-spare: 50
    max-connections: 500
    accept-count: 20
    connection-timeout: 20000

# API 서버 (빠른 응답)
server:
  tomcat:
    threads:
      max: 100
      min-spare: 20
    max-connections: 200
    accept-count: 10
    connection-timeout: 5000

# 내부 관리 도구 (트래픽 적음)
server:
  tomcat:
    threads:
      max: 50
      min-spare: 10
    max-connections: 100
    accept-count: 10
```

> 출처: [Velog - Tomcat Thread Pool 정리](https://velog.io/@mooh2jj/Tomcat-Thread-Pool-정리)

## 4. Spring MVC 요청 처리 과정

톰캣이 요청을 받았습니다. 이제 Spring MVC로 넘어가겠습니다.

### 4.1 전체 흐름

![](/uploads/theory/tomcat-nio-request-handling/41-overall-flow.svg)


### 4.2 DispatcherServlet: Front Controller

![](/uploads/theory/tomcat-nio-request-handling/42-dispatcher-servlet-front-controller.svg)


```java
// DispatcherServlet의 핵심 메서드 (단순화)
public class DispatcherServlet extends HttpServlet {

    private List<HandlerMapping> handlerMappings;
    private List<HandlerAdapter> handlerAdapters;
    private List<ViewResolver> viewResolvers;

    protected void doDispatch(HttpServletRequest request,
                             HttpServletResponse response) {

        // 1. HandlerMapping으로 컨트롤러 찾기
        HandlerExecutionChain handler = getHandler(request);
        if (handler == null) {
            response.sendError(404);
            return;
        }

        // 2. HandlerAdapter 찾기
        HandlerAdapter adapter = getHandlerAdapter(handler.getHandler());

        // 3. Interceptor - preHandle
        if (!handler.applyPreHandle(request, response)) {
            return;
        }

        // 4. 실제 컨트롤러 실행
        ModelAndView mv = adapter.handle(request, response, handler.getHandler());

        // 5. Interceptor - postHandle
        handler.applyPostHandle(request, response, mv);

        // 6. View 렌더링 (REST API는 생략)
        if (mv != null) {
            render(mv, request, response);
        }

        // 7. Interceptor - afterCompletion
        handler.triggerAfterCompletion(request, response, null);
    }
}
```

> 출처: [Tecoble - DispatcherServlet Part 1](https://tecoble.techcourse.co.kr/post/2021-06-25-dispatcherservlet-part-1/)

### 4.3 HandlerMapping: URL → Controller 매핑

![](/uploads/theory/tomcat-nio-request-handling/43-handler-mapping-url-controller-mapping.svg)


```java
// HandlerMapping의 역할
@RestController
@RequestMapping("/api/streams")
class StreamController {

    @GetMapping("/{id}")  // 이 매핑 정보를 HandlerMapping이 관리
    public StreamDto getStream(@PathVariable Long id) {
        return streamService.findById(id);
    }
}

// HandlerMapping이 관리하는 맵 (단순화)
class RequestMappingHandlerMapping {

    Map<RequestMappingInfo, HandlerMethod> mappings = new HashMap<>();

    void registerMapping() {
        // 애플리케이션 시작 시 등록
        RequestMappingInfo info = new RequestMappingInfo(
            "/api/streams/{id}",
            RequestMethod.GET
        );

        HandlerMethod method = new HandlerMethod(
            streamController,          // 빈
            "getStream",               // 메서드 이름
            Long.class                 // 파라미터 타입
        );

        mappings.put(info, method);
    }

    HandlerMethod getHandler(HttpServletRequest request) {
        String uri = request.getRequestURI();      // "/api/streams/123"
        String method = request.getMethod();        // "GET"

        // 매핑 찾기
        for (Entry<RequestMappingInfo, HandlerMethod> entry : mappings.entrySet()) {
            if (entry.getKey().matches(uri, method)) {
                return entry.getValue();  // StreamController.getStream
            }
        }

        return null;  // 404
    }
}
```

**여러 HandlerMapping이 있는 이유**:

```java
// Spring은 여러 HandlerMapping을 순서대로 시도
List<HandlerMapping> handlerMappings = Arrays.asList(
    new RequestMappingHandlerMapping(),  // @RequestMapping
    new BeanNameUrlHandlerMapping(),      // 빈 이름으로 매핑
    new SimpleUrlHandlerMapping()         // 직접 URL 매핑
);

HandlerExecutionChain getHandler(HttpServletRequest request) {
    for (HandlerMapping mapping : handlerMappings) {
        HandlerExecutionChain handler = mapping.getHandler(request);
        if (handler != null) {
            return handler;
        }
    }
    return null;
}
```

### 4.4 HandlerAdapter: Controller 실행

**왜 HandlerAdapter가 필요할까?**

Controller가 여러 형태를 가질 수 있기 때문입니다.

```java
// 형태 1: @Controller 애너테이션
@RestController
class ModernController {
    @GetMapping("/api/users")
    public List<User> getUsers() {
        return userService.findAll();
    }
}

// 형태 2: Controller 인터페이스 구현 (옛날 방식)
class OldSchoolController implements Controller {
    @Override
    public ModelAndView handleRequest(HttpServletRequest req,
                                     HttpServletResponse res) {
        // ...
    }
}

// 형태 3: HttpRequestHandler
class SimpleController implements HttpRequestHandler {
    @Override
    public void handleRequest(HttpServletRequest req,
                             HttpServletResponse res) {
        // ...
    }
}
```

**HandlerAdapter는 이 차이를 흡수한다**:

```java
// HandlerAdapter 인터페이스
interface HandlerAdapter {
    boolean supports(Object handler);  // 이 핸들러 처리 가능?
    ModelAndView handle(HttpServletRequest req,
                       HttpServletResponse res,
                       Object handler);
}

// 예시: RequestMappingHandlerAdapter
class RequestMappingHandlerAdapter implements HandlerAdapter {

    @Override
    public boolean supports(Object handler) {
        return handler instanceof HandlerMethod;  // @RequestMapping 메서드
    }

    @Override
    public ModelAndView handle(HttpServletRequest req,
                              HttpServletResponse res,
                              Object handler) {
        HandlerMethod method = (HandlerMethod) handler;

        // 1. 파라미터 리졸빙
        Object[] args = resolveArguments(method, req);
        // @PathVariable, @RequestBody 등 처리

        // 2. 메서드 실행
        Object result = method.invoke(args);

        // 3. 반환값 처리
        if (method.isAnnotatedWith(ResponseBody.class)) {
            // MessageConverter로 JSON 변환
            writeJson(res, result);
            return null;
        }

        return new ModelAndView("viewName", result);
    }
}
```

![](/uploads/theory/tomcat-nio-request-handling/44-handler-adapter-controller-execution.svg)



> 출처: [Spring MVC - HandlerMapping, HandlerAdapter](https://gist.github.com/taekwon-dev/0345a8f99613a1d49b10276b63d27a63)

### 4.5 실제 요청 처리 시간 분석

```java
@RestController
class PerformanceController {

    @GetMapping("/api/benchmark")
    public String benchmark() {
        // 각 단계별 시간 측정
        return "OK";
    }
}
```

**실제 측정** (로컬 환경):
![](/uploads/theory/tomcat-nio-request-handling/45-actual-request-handle-time-analysis.svg)

**병목은 어디?**

```java
// 느린 Controller
@GetMapping("/api/slow")
public List<UserDto> getUsers() {
    // 1. DB 조회: 100ms
    List<User> users = userRepository.findAll();

    // 2. N+1 문제: 500ms
    for (User user : users) {
        user.getOrders().size();  // Lazy Loading
    }

    // 3. DTO 변환: 50ms
    return users.stream()
        .map(UserDto::from)
        .collect(Collectors.toList());
}

// 총 시간: 650ms
// Spring MVC 오버헤드: 2.5ms (0.4%)
// 실제 로직: 650ms (99.6%)
```

**결론**: Spring MVC 자체는 매우 빠릅니다. 병목은 대부분 비즈니스 로직에 있습니다.

## 5. 실제 트러블슈팅 사례

### 5.1 카카오페이: Spring Batch 성능 최적화

> 참고: 아래 사례는 톰캣 NIO와는 직접적 관련이 없지만, Spring 환경에서의 대규모 처리 최적화 관점에서 참고할 만한 사례이다.

**문제 상황**:

카카오페이 정산플랫폼팀에서 유저 등급 업데이트 배치 작업을 실행했습니다. 5만 개 레코드 처리에 **1시간 이상** 소요되었습니다.

```kotlin
// 문제가 있던 코드 (단순화)
@Configuration
class UserGradeBatchConfig {

    @Bean
    fun updateUserGradeJob(): Job {
        return jobBuilderFactory.get("updateUserGrade")
            .start(updateGradeStep())
            .build()
    }

    @Bean
    fun updateGradeStep(): Step {
        return stepBuilderFactory.get("updateGrade")
            .<User, User>chunk(1000)
            .reader(userReader())
            .processor(gradeProcessor())  // 문제!
            .writer(userWriter())
            .build()
    }
}

// Processor: 외부 API 호출
class GradeProcessor : ItemProcessor<User, User> {
    override fun process(user: User): User {
        // 외부 API 호출: 150ms
        val point = externalApi.getUserPoint(user.id)  // Blocking!
        user.grade = calculateGrade(point)
        return user
    }
}
```

**문제 분석**:

```
Chunk 크기: 1,000
외부 API 응답 시간: 150ms
총 레코드: 50,000개

처리 과정:
1. 1,000개 읽기
2. 1,000개 처리 (각 150ms) = 150,000ms (2.5분)
3. 1,000개 쓰기
4. 다음 청크...

총 시간: 50 chunks × 2.5분 = 125분 (2시간)
```

**해결 방법 1: 병렬 처리** (RxKotlin)

```kotlin
class ParallelGradeProcessor : ItemProcessor<User, User> {

    override fun process(user: User): User {
        // RxKotlin으로 병렬 처리
        return Observable.just(user)
            .flatMap { u ->
                Observable.fromCallable {
                    externalApi.getUserPoint(u.id)
                }
                .subscribeOn(Schedulers.io())  // 병렬 실행!
            }
            .map { point ->
                user.grade = calculateGrade(point)
                user
            }
            .blockingFirst()
    }
}
```

**결과**:
- 개선 전: 125분
- 개선 후: 12분
- **약 10배 개선**

**해결 방법 2: IN UPDATE 최적화**

```kotlin
// 문제: 단건 업데이트 1,000번
UPDATE users SET grade = 'GOLD' WHERE id = 1;
UPDATE users SET grade = 'GOLD' WHERE id = 2;
// ... 1,000번 반복

// 해결: 등급별로 그룹화하여 IN UPDATE
UPDATE users SET grade = 'GOLD' WHERE id IN (1, 2, 3, ..., 500);
UPDATE users SET grade = 'SILVER' WHERE id IN (501, 502, ..., 800);
UPDATE users SET grade = 'BRONZE' WHERE id IN (801, 802, ..., 1000);

// 1,000번 → 3번!
```

**결과**:
- 5,000개 레코드부터 **90% 이상 성능 향상**

> 출처: [카카오페이 - Spring Batch 애플리케이션 성능 향상을 위한 주요 팁](https://tech.kakaopay.com/post/spring-batch-performance/)

### 5.2 톰캣 스레드 고갈

**상황**:

라이브 스트리밍 서비스에서 갑자기 응답이 느려졌습니다.

```yaml
# 기존 설정
server:
  tomcat:
    threads:
      max: 200
```

**증상**:

```
2025-01-10 14:23:15 WARN  o.a.tomcat.util.threads.ThreadPoolExecutor
- Pool exhausted with 200 threads, queue is full

2025-01-10 14:23:16 ERROR o.s.web.servlet.DispatcherServlet
- Handler dispatch failed: java.util.concurrent.RejectedExecutionException
```

**원인 분석**:

```java
// 문제가 있던 API
@GetMapping("/api/streams/live")
public List<StreamDto> getLiveStreams() {
    // 1. DB 조회 (느린 쿼리): 5초
    List<Stream> streams = streamRepository.findAllLive();

    // 2. N+1 문제: 10초
    for (Stream stream : streams) {
        stream.getUser().getNickname();  // Lazy Loading
        stream.getTags().size();          // Lazy Loading
    }

    return streams.stream()
        .map(StreamDto::from)
        .collect(Collectors.toList());
}

// 총 처리 시간: 15초
// maxThreads = 200
// 초당 요청: 20개

// 15초 × 20 req/s = 300개 스레드 필요!
// 하지만 200개만 있음 → 고갈!
```

**해결 1: 쿼리 최적화**

```java
// Fetch Join으로 N+1 해결
@Query("""
    SELECT s FROM Stream s
    JOIN FETCH s.user
    JOIN FETCH s.tags
    WHERE s.status = 'LIVE'
""")
List<Stream> findAllLiveWithFetch();

// 처리 시간: 15초 → 0.5초
// 필요 스레드: 0.5초 × 20 req/s = 10개
```

**해결 2: 캐싱**

```java
@Cacheable("liveStreams")
@GetMapping("/api/streams/live")
public List<StreamDto> getLiveStreams() {
    // 캐시 히트: 10ms
    // 캐시 미스: 500ms (쿼리 최적화 후)
    return streamService.findAllLive();
}

// 필요 스레드: 거의 없음 (대부분 캐시 히트)
```

### 5.3 maxConnections vs maxThreads 혼동

**잘못된 설정**:

```yaml
server:
  tomcat:
    threads:
      max: 200
    max-connections: 10000  # 너무 크다!
```

**문제**:

```
동시 연결: 10,000개
워커 스레드: 200개

상황:
- 10,000개 연결 모두 Poller가 관리
- 하지만 200개만 동시 처리 가능
- 9,800개는 대기만 함
- 메모리: 10,000 × 100KB = 1GB 낭비!
```

**올바른 설정**:

```yaml
server:
  tomcat:
    threads:
      max: 200
    max-connections: 8192   # NIO에서는 Poller가 유휴 연결을 효율적으로 관리하므로 기본값이 적합
    accept-count: 20        # 빠른 실패
```

**이유**:

```
NIO 환경에서는 유휴 연결을 Poller가 효율적으로 관리하므로
기본값 8192가 대부분의 경우 적합하다.
메모리가 제한적인 환경에서만 낮추는 것을 고려한다.
```

## 6. 전체 흐름 정리


이제 전체 그림이 보입니다.

![](/uploads/theory/tomcat-nio-request-handling/6-overall-flow-summary.svg)



**각 계층의 처리 시간** (일반적인 REST API):

![](/uploads/theory/tomcat-nio-request-handling/6-overall-flow-summary-2.svg)


**결론**: 대부분의 경우 DB가 병목입니다. 톰캣과 Spring MVC는 충분히 빠릅니다.

## 7. 마치며

톰캣 커넥터부터 Spring MVC까지 공부하고 나니, 이제 요청 하나가 어떻게 처리되는지 전체 그림이 그려집니다.

**핵심 정리**:

1. **BIO → NIO**: 스레드 낭비를 막기 위해 Selector 기반으로 변경
2. **Acceptor, Poller, Executor**: 각자 역할을 나눠서 효율적으로 처리
3. **Selector (epoll)**: 커널 레벨에서 여러 소켓을 동시에 감시
4. **maxThreads, maxConnections, acceptCount**: 각각 다른 의미, 혼동 금지
5. **Spring MVC**: DispatcherServlet이 중앙 집중식으로 요청 분배
6. **병목은 대부분 DB**: 쿼리 최적화가 제일 중요

나중에는 비동기 처리(WebFlux)와 리액티브 프로그래밍을 공부해서, 더 효율적인 서버를 만들어 봐야겠습니다.

## 참고 자료

### 한국 기술 블로그
- [nilgil.com - 톰캣은 어떻게 트래픽을 인지하고 처리하는 걸까?](https://nilgil.com/blog/how-does-tomcat-recognize-and-handle-traffic/) - 톰캣 NIO Connector 소스 코드 분석
- [px201226.github.io - Apache Tomcat 이해하기(NIO Connector 중심)](https://px201226.github.io/tomcat/) - Acceptor, Poller, Executor 구조 설명
- [Velog - BIO, NIO Connector Architecture in Tomcat](https://velog.io/@jihoson94/BIO-NIO-Connector-in-Tomcat) - BIO와 NIO 비교
- [Velog - Tomcat BIO Connector & NIO Connector](https://velog.io/@appti/Tomcat-BIO-Connector-NIO-Connector) - 성능 차이 분석
- [Velog - Tomcat의 maxConnections, maxThreads, acceptCount](https://velog.io/@junho5336/톰캣의-maxConnections-maxThreads-acceptCount-설정하기) - 설정값 설명
- [Hudi Blog - 톰캣 튜닝 맛보기](https://hudi.blog/tomcat-tuning-exercise/) - 실전 튜닝 사례
- [Velog - Tomcat Thread Pool 정리](https://velog.io/@mooh2jj/Tomcat-Thread-Pool-정리) - 스레드 풀 설정
- [Tecoble - DispatcherServlet Part 1](https://tecoble.techcourse.co.kr/post/2021-06-25-dispatcherservlet-part-1/) - Spring MVC 동작 원리
- [카카오페이 - Spring Batch 애플리케이션 성능 향상을 위한 주요 팁](https://tech.kakaopay.com/post/spring-batch-performance/) - 실제 트러블슈팅 사례

### 해외 기술 블로그
- [Netflix Tech Blog - Tuning Tomcat For A High Throughput, Fail Fast System](https://netflixtechblog.com/tuning-tomcat-for-a-high-throughput-fail-fast-system-e4d7b2fc163f) - Netflix의 톰캣 튜닝 전략

### CS 지식
- [NiklasJang's Blog - select, poll, epoll 구조](https://niklasjang.github.io/backend/select-poll-epoll/) - epoll 동작 원리

### Spring 공식 문서
- [Spring MVC - HandlerMapping, HandlerAdapter](https://gist.github.com/taekwon-dev/0345a8f99613a1d49b10276b63d27a63) - HandlerMapping과 HandlerAdapter 설명
