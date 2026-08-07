---
title: '스프링 MVC는 왜 스레드를 최대 200개까지 사용할까'
description: CGI 시절부터 서블릿, 스레드 풀까지의 역사를 따라가며 톰캣의 기본 스레드 수 200의 의미와 스레드 풀 튜닝 전략을 정리한다.
date: 2025-08-07T00:00:00.000Z
tags:
  - Spring MVC
  - Thread Pool
  - Tomcat
  - Servlet
  - Performance
  - Concurrency
category: theory/Web-Server
draft: false
coverImage: "/uploads/theory/spring-mvc-thread-pool/cgi-process-hell-start.svg"
series: "요청 처리"
---


동시 접속자 처리를 고민하다가 궁금해진 부분을 정리해봤습니다.

---

## 들어가며

스프링 부트로 서버 만들 때 항상 신경 쓰이는 게 "이 서버가 과연 몇 명을 동시에 받을 수 있을까?"였습니다. 설정 파일을 열어보면 톰캣 스레드 최대치가 200으로 박혀있는데, 이게 왜 200인지는 아무도 안 알려줍니다.

처음엔 그냥 "200명까지만 받을 수 있나?" 싶었는데, 찾아보니 생각보다 복잡한 이유가 있었습니다.

---

## 옛날 옛적 CGI 시절 이야기

### CGI: 프로세스 지옥의 시작

1990년대 초반, 웹은 정적인 HTML 파일만 보여주는 수준이었습니다. 사용자 입력에 따라 동적으로 페이지를 만들 방법이 필요했고, CGI(Common Gateway Interface)가 등장했습니다.

> 출처: [Velog - CGI와 서블릿, JSP의 연관관계](https://velog.io/@suhongkim98/CGI와-서블릿-JSP의-연관관계-알아보기)

CGI는 간단했습니다. 요청이 오면 프로그램을 실행하고 결과를 HTML로 반환하면 끝이었습니다.

![](/uploads/theory/spring-mvc-thread-pool/cgi-process-hell-start.svg)

문제는 성능이었습니다.

**요청 하나당 프로세스 하나.**

10명이 동시 접속하면 프로세스 10개, 100명이면 100개. 프로세스 생성하는데 수십 ms씩 걸렸고, 메모리는 프로세스마다 수 MB씩 먹었습니다. 컨텍스트 스위칭도 무시할 수 없었습니다.

동시 접속자 100명만 넘어가도 서버가 터졌습니다.

> 출처: [80000coding - 웹 서버와 WAS, CGI](https://80000coding.oopy.io/2352c04e-8f98-4695-a5fe-8c789ee94d98)

### 서블릿: 스레드 기반의 혁명

1997년, Sun이 해결책을 내놓았습니다. Java Servlet이었습니다.

핵심 아이디어는 **프로세스 대신 스레드를 쓰자**는 것이었습니다.


CGI 방식
![](/uploads/theory/spring-mvc-thread-pool/servlet-thread-based-revolution.svg)


서블릿 방식:

![](/uploads/theory/spring-mvc-thread-pool/servlet-thread-based-revolution-2.svg)



스레드는 프로세스보다 가볍고 빨랐습니다. 생성 비용도 낮고 메모리도 덜 먹었습니다. 무엇보다 **스레드 풀**을 만들어서 재사용할 수 있었습니다.

> 출처: [Wikipedia - 자바 서블릿](https://ko.wikipedia.org/wiki/자바_서블릿), [Pearson IT Certification - Servlet and JSP History](https://www.pearsonitcertification.com/articles/article.aspx?p=29786&seqNum=3)

```java
// 서블릿 컨테이너의 동작 방식
class ServletContainer {
    ThreadPool pool = new ThreadPool(200); // 미리 생성

    void handleRequest(HttpRequest request) {
        pool.submit(() -> {
            servlet.service(request);
            // 요청 처리 완료 후 스레드가 자동으로 풀에 반환됨
        });
    }
}
```

이게 바로 톰캣의 시작이었습니다. 1999년, Sun이 톰캣 코드를 Apache 재단에 기부하면서 Apache Tomcat이 탄생했습니다.

> 출처: [Apache Tomcat Heritage](https://tomcat.apache.org/heritage.html)

### 서블릿의 내부 구조

서블릿이 프로세스보다 효율적인 이유를 좀 더 깊이 파헤쳐 보겠습니다.

#### CGI vs 서블릿: 메모리 구조 비교


CGI 방식:
![](/uploads/theory/spring-mvc-thread-pool/cgi-vs-servlet-memory-architecture.svg)


서블릿 방식:

![](/uploads/theory/spring-mvc-thread-pool/cgi-vs-servlet-memory-architecture-2.svg)

→ Code, Data, Heap은 공유하고 Stack만 따로!


**핵심**: 스레드는 Code, Data, Heap 영역을 공유하고 Stack만 각자 가집니다. 메모리 효율이 압도적으로 좋습니다.

> 출처: [Velog - 자바 서블릿에 대해 알아보자](https://velog.io/@jakeseo_me/자바-서블릿에-대해-알아보자.-근데-톰캣과-스프링을-살짝-곁들인)

#### 서블릿의 라이프사이클

서블릿은 한 번 생성되면 메모리에 계속 남아있습니다. **싱글톤 패턴**처럼 동작합니다.

```java
// 서블릿 라이프사이클
public class MyServlet extends HttpServlet {

    // 1. init(): 서블릿이 처음 생성될 때 단 한 번 호출
    @Override
    public void init(ServletConfig config) throws ServletException {
        System.out.println("서블릿 초기화!");
        // DB 커넥션 풀 초기화 등의 작업
    }

    // 2. service(): 요청이 올 때마다 호출 (멀티스레드로 동작)
    @Override
    protected void service(HttpServletRequest req, HttpServletResponse res)
            throws ServletException, IOException {
        // GET, POST 등 HTTP 메서드에 따라 분기
        String method = req.getMethod();
        if (method.equals("GET")) {
            doGet(req, res);
        } else if (method.equals("POST")) {
            doPost(req, res);
        }
    }

    // 3. destroy(): 서블릿이 제거될 때 단 한 번 호출
    @Override
    public void destroy() {
        System.out.println("서블릿 종료!");
        // 리소스 정리
    }
}
```

**중요한 점**:

![](/uploads/theory/spring-mvc-thread-pool/servlet.svg)




실제로 측정해보면 차이가 확연합니다:

```java
// 첫 번째 요청
GET http://localhost:8080/myServlet
// 응답 시간: 38.50ms (서블릿 초기화 포함)

// 두 번째 요청
GET http://localhost:8080/myServlet
// 응답 시간: 6.61ms (서블릿 재사용!)
```

> 참고: Spring의 DispatcherServlet은 `load-on-startup=1`이 기본이므로 서버 시작 시 바로 초기화된다. 위 차이는 순수 서블릿 API 사용 시의 예시이다.

> 출처: [Velog - 자바 서블릿에 대해 알아보자](https://velog.io/@jakeseo_me/자바-서블릿에-대해-알아보자.-근데-톰캣과-스프링을-살짝-곁들인)

#### Lazy Loading: 필요할 때만 만든다

서블릿은 **처음 접근할 때** 생성됩니다. 서버가 시작될 때 모든 서블릿을 만들지 않습니다.
![](/uploads/theory/spring-mvc-thread-pool/lazy-loading-need.svg)


**왜 이렇게 할까?**
- 서버 시작 시간 단축
- 사용하지 않는 서블릿은 메모리를 차지하지 않음
- 첫 요청만 조금 느리고, 이후는 빠름

#### 싱글톤의 함정: 공유 메모리 문제

서블릿이 싱글톤이라는 건, **모든 스레드가 같은 서블릿 객체를 공유**한다는 뜻입니다.

```java
// 위험한 코드!
public class DangerousServlet extends HttpServlet {
    private int count = 0; // 인스턴스 변수 (공유됨!)

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse res)
            throws ServletException, IOException {
        count++; // 여러 스레드가 동시에 접근!
        res.getWriter().write("Count: " + count);
    }
}

// 시나리오:
// Thread 1: count++ (0 → 1)
// Thread 2: count++ (동시에 접근, 1 → 2가 아니라 1 → 1이 될 수도!)
// Thread 3: count++ (경쟁 조건 발생!)
```

**해결책**:

1. **지역 변수만 사용**
```java
public class SafeServlet extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse res)
            throws ServletException, IOException {
        int count = 0; // 지역 변수 (스레드마다 Stack에 따로 생김)
        count++;
        res.getWriter().write("Count: " + count);
    }
}
```

2. **동기화 사용** (하지만 느려짐)
```java
public class SynchronizedServlet extends HttpServlet {
    private int count = 0;

    @Override
    protected synchronized void doGet(HttpServletRequest req, HttpServletResponse res)
            throws ServletException, IOException {
        count++; // 한 번에 하나의 스레드만 접근
        res.getWriter().write("Count: " + count);
    }
}
```

**권장**: 서블릿에서는 **상태를 저장하지 말고**, 요청 처리 후 바로 잊어버리는 게 좋습니다.

> 출처: [Velog - 자바 서블릿에 대해 알아보자](https://velog.io/@jakeseo_me/자바-서블릿에-대해-알아보자.-근데-톰캣과-스프링을-살짝-곁들인)

#### 스프링의 DispatcherServlet

스프링은 **단 하나의 서블릿**으로 모든 요청을 처리합니다.

```java
// 스프링의 핵심: DispatcherServlet
public class DispatcherServlet extends FrameworkServlet {

    @Override
    protected void doService(HttpServletRequest req, HttpServletResponse res)
            throws Exception {

        // 1. 핸들러 매핑: 어떤 컨트롤러가 처리할지 찾기
        HandlerExecutionChain handler = getHandler(req);
        // GET /api/user → UserController.getUser()

        // 2. 핸들러 어댑터: 컨트롤러 실행 방법 결정
        HandlerAdapter adapter = getHandlerAdapter(handler);
        // @RestController면 JSON 반환
        // @Controller면 View 이름 반환

        // 3. 실제 실행
        ModelAndView mv = adapter.handle(req, res, handler);

        // 4. 뷰 렌더링 (필요한 경우)
        render(mv, req, res);
    }
}
```

**동작 흐름**:
![](/uploads/theory/spring-mvc-thread-pool/spring-dispatcherservlet.svg)


**핵심**: 개발자는 `@RestController`나 `@Controller`만 만들면 되고, 서블릿 코드는 스프링이 알아서 처리해 줍니다.

> 출처: [Velog - 자바 서블릿에 대해 알아보자](https://velog.io/@jakeseo_me/자바-서블릿에-대해-알아보자.-근데-톰캣과-스프링을-살짝-곁들인)

---

## 톰캣의 진화: BIO에서 NIO로

### Tomcat 7 이전: BIO의 시대

초기 톰캣은 BIO(Blocking I/O) 커넥터를 기본으로 썼습니다.

동작 방식은 이랬습니다:

![](/uploads/theory/spring-mvc-thread-pool/tomcat-7-bio.svg)


문제는 **Keep-Alive**였습니다.

HTTP/1.1에서는 연결을 재사용합니다. 요청 처리하고 나서도 연결을 끊지 않고 다음 요청을 기다립니다. 보통 5-30초 정도 기다립니다.

![](/uploads/theory/spring-mvc-thread-pool/tomcat-7-bio-2.svg)


BIO에서는 이 5초 동안 스레드가 아무것도 안 하고 대기합니다. 스레드 풀이 200개면, 200명이 동시 접속하면 끝이었습니다. 201번째 사용자는 누군가 연결을 끊을 때까지 기다려야 했습니다.

> 출처: [Velog - 아파치 톰캣의 NIO Connector와 BIO Connector](https://velog.io/@cjh8746/아파치-톰캣의-NIO-Connector-와-BIO-Connector에-대해-알아보자)

### C10K 문제

1999년, Dan Kegel이 문제를 제기했습니다. **"10,000개 동시 연결을 어떻게 처리할 것인가?"**

BIO 방식으로는 불가능했습니다. 10,000개 스레드를 만들면:

```
메모리: 10,000 * 1MB = 10GB
컨텍스트 스위칭: 초당 수백만 번
CPU: 코어당 2,500개 스레드 스케줄링으로 유효 CPU 시간이 크게 감소
```

> 출처: [Wikipedia - C10k problem](https://en.wikipedia.org/wiki/C10k_problem)

### Tomcat 8: NIO로의 전환

2014년, Tomcat 8이 나오면서 NIO(Non-blocking I/O)가 기본이 됐습니다.

NIO의 핵심은 **Selector**입니다.

```java
// NIO Connector의 동작 방식
class NioConnector {
    Selector selector = Selector.open();
    ThreadPool workerPool = new ThreadPool(200);

    void acceptConnection(SocketChannel channel) {
        // Selector에 등록만 하고 스레드는 할당 안 함
        channel.register(selector, SelectionKey.OP_READ);
    }

    void pollLoop() {
        while (true) {
            // 여러 연결을 동시에 감시
            selector.select();

            for (SelectionKey key : selector.selectedKeys()) {
                if (key.isReadable()) {
                    // 데이터가 있을 때만 워커 스레드 할당
                    SocketChannel ch = (SocketChannel) key.channel();
                    workerPool.submit(() -> processRequest(ch));
                }
            }
        }
    }
}
```

이제 연결 개수와 스레드 개수가 분리됐습니다.

```
BIO:
200개 스레드 = 최대 200개 동시 연결

NIO:
200개 워커 스레드
+ Poller 스레드 1개 (Tomcat 8.5+는 커넥터당 1개로 고정)
= 최대 8,192개 동시 연결 (Tomcat 8 기본값)
```

Keep-Alive 대기 중인 연결은 Selector가 관리하고, 실제로 데이터가 오면 그때 워커 스레드를 할당합니다.

> 출처: [Stack Overflow - Tomcat NIO thread pools](https://stackoverflow.com/questions/40722254/tomcat-nio-thread-pools)

### Tomcat 8.5/9: BIO 완전 제거

2016년, Tomcat 8.5와 9가 나오면서 BIO는 완전히 사라졌습니다.

```java
// Tomcat 8.5부터
<Connector protocol="HTTP/1.1" />
// → 자동으로 NIO 사용

// BIO를 명시적으로 설정해도
<Connector protocol="org.apache.coyote.http11.Http11Protocol" />
// → 경고 로그와 함께 NIO로 전환됨
```

> 출처: [Apache Tomcat Migration Guide 8.5](https://tomcat.apache.org/migration-85.html), [Tomcat 9 Migration Guide](https://tomcat.apache.org/migration-9.html)

---

## 스프링 부트와 톰캣의 스레드 풀

### 기본 설정값

스프링 부트에 내장된 톰캣의 기본 설정은 이렇습니다:

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `server.tomcat.threads.max` | 200 | 최대 워커 스레드 개수 |
| `server.tomcat.threads.min-spare` | 10 | 최소 유지 스레드 개수 |
| `server.tomcat.max-connections` | 8192 (NIO), 10000 (NIO2) | 최대 동시 연결 수 |
| `server.tomcat.accept-count` | 100 | 대기 큐 크기 |

> 출처: [Apache Tomcat 8.5 Configuration Reference](https://tomcat.apache.org/tomcat-8.5-doc/config/http.html), [Datadog - Understanding Tomcat Architecture](https://www.datadoghq.com/blog/tomcat-architecture-and-performance/)

### NIO 커넥터의 스레드 구조

톰캣 NIO 커넥터는 여러 종류의 스레드를 씁니다:

```
http-nio-8080-Acceptor-0 (1개)
  → 연결 수락

http-nio-8080-ClientPoller (Tomcat 8.5+는 커넥터당 1개로 고정)
  (8.5에서 pollerThreadCount 옵션 제거 — "one poller thread is sufficient". 8.0 이전엔 min(2, 코어수)였음)
  → Selector로 연결 감시

http-nio-8080-exec-1 (10~200개)
http-nio-8080-exec-2
...
http-nio-8080-exec-200
  → 실제 요청 처리
```

Acceptor가 연결을 받으면 Poller에게 넘기고, Poller가 데이터를 감지하면 Exec 스레드에게 작업을 줍니다.

> 출처: [DZone - Understanding the Tomcat NIO Connector](https://dzone.com/articles/understanding-tomcat-nio)

### 요청 처리 흐름

스프링 부트는 이렇게 요청을 처리합니다:

![](/uploads/theory/spring-mvc-thread-pool/request-handle-flow.svg)


200개 스레드가 모두 사용 중이면:

![](/uploads/theory/spring-mvc-thread-pool/request-handle-flow-2.svg)


```
1. max-connections (8192개) 내의 연결은 Poller가 관리
2. accept-count (100개) 까지는 OS 레벨 큐에서 대기
3. 두 제한을 모두 초과하면 OS가 TCP SYN을 drop하여 클라이언트에서 Connection refused 발생
```

> 출처: [Velog - 스프링부트는 어떻게 다중 유저 요청을 처리할까?](https://velog.io/@sihyung92/how-does-springboot-handle-multiple-requests), [HARIL - Spring MVC Traffic Testing](https://haril.dev/blog/2023/11/10/Spring-MVC-Traffic-Testing)

---

## 왜 하필 200개인가?

### 1. 메모리와의 균형

먼저 JVM 메모리 구조부터 이해해야 합니다.

#### JVM 메모리 구조

![](/uploads/theory/spring-mvc-thread-pool/jvm-memory-architecture.svg)


**Heap:**
- 모든 스레드가 공유하는 메모리 공간
- 객체, 배열이 여기에 할당됨
- `-Xms`, `-Xmx` 옵션으로 크기 설정

**Stack:**
- 각 스레드마다 독립적인 스택 공간
- 메서드 호출, 지역 변수, 파라미터 저장
- `-Xss` 옵션으로 크기 설정 (기본 1MB)

> 출처: [Baeldung - Stack Memory and Heap Space](https://www.baeldung.com/java-stack-heap), [Java Memory Model](https://jenkov.com/tutorials/java-concurrency/java-memory-model.html)

#### 스레드 메모리 계산

64비트 JVM에서 스레드 하나는 기본 1MB 스택을 먹습니다.

실제로는 이렇습니다:

```
스레드가 sleep 상태일 때: 약 16KB (물리 RAM)
스택을 실제로 쓸 때: 최대 1MB까지 증가
```

200개 스레드면:

```
스택 메모리:
- 최소: 200 * 16KB = 3.2MB
- 최대: 200 * 1MB = 200MB

전체 JVM:
- Heap: 예를 들어 2GB (-Xmx2g)
- Stack: 200MB (200 threads)
- Metaspace: 약 256MB
= 총 2.5GB 정도
```

이 정도면 일반적인 서버 메모리(4-8GB)에서 무리 없습니다.

> 출처: [Stack Overflow - Java thread memory calculation](https://stackoverflow.com/questions/67068623/java-thread-memory-calculation), [DZone - How Much Memory Does a Java Thread Take?](https://dzone.com/articles/how-much-memory-does-a-java-thread-take)

### 2. 컨텍스트 스위칭 비용

현대 리눅스에서 컨텍스트 스위칭은 1-2 마이크로초 걸립니다.

```
스레드 A 레지스터 저장 → 스레드 B 레지스터 복원 → TLB flush
= 약 1-2μs
```

200개 스레드가 공평하게 CPU를 나눠 쓴다면, CPU 4코어 기준으로 스레드 하나당:

```
4 / 200 = 0.02 (2%)
```

적당히 많으면서도 컨텍스트 스위칭 오버헤드가 크지 않은 수준입니다.

만약 2000개 스레드를 만들면:

```
4 / 2000 = 0.002 (0.2%)
2000개 스레드에서는 컨텍스트 스위칭 오버헤드가 급격히 증가한다.
코어당 500개 스레드를 스케줄링하면 유효 CPU 시간이 크게 줄어든다.
```

> 출처: [Eli Bendersky - Measuring context switching](https://eli.thegreenplace.net/2018/measuring-context-switching-and-memory-overheads-for-linux-threads/), [Medium - Context Switching Impact](https://serkanerip.medium.com/the-performance-impact-of-excessive-context-switching-a8aa023ba542)

### 3. 역사적 이유

초기 톰캣(1999년)이 나왔을 때 서버 스펙은 이랬습니다:

```
CPU: Pentium III 500MHz
RAM: 128-512MB
동시 접속자: 수백 명 수준
```

이 환경에서 테스트하면서 "150-200개 정도가 적당하다"는 결론이 나왔습니다. 그게 지금까지 기본값으로 남아있습니다.

> 출처: [Medium - Tomcat Why 200 Threads](https://alpitanand20.medium.com/tomcat-why-just-200-default-threads-febd2411b904)

실제로 톰캣 공식 문서를 보면:

> "The default configuration is intended for medium load/complexity applications on average hardware."

평범한 하드웨어에서 중간 규모 부하를 처리하도록 설계됐다는 뜻입니다.

---

## 실전 성능 테스트 결과

### EC2 t4g.small 테스트

한 개발자가 EC2 t4g.small (2코어, 2GB RAM)에서 스프링 부트 3.1.5로 부하 테스트를 돌렸습니다.

**기본 설정 (threads.max=200):**

```
300개 동시 요청: 정상 처리
10,000개 요청: timeout 발생
```

**최적화 설정 (threads.max=2000, max-connections=50000):**

```
15,000개 동시 요청: 정상 처리
```

> 참고: Thread.sleep 같은 가벼운 요청은 실제 스레드 스택을 거의 사용하지 않으므로, 2000개 스레드가 모두 1MB씩 사용하지는 않는다. 실제 메모리 사용량은 활성 스택 프레임 깊이에 따라 다르다.

서버 성능은 하드웨어와 설정에 크게 의존한다는 걸 보여줍니다.

> 출처: [HARIL - Spring MVC Traffic Testing](https://haril.dev/blog/2023/11/10/Spring-MVC-Traffic-Testing)

### 최적화 고려사항

**너무 낮게 설정하면:**

```
threads.max=50
→ 서버 리소스는 남는데 클라이언트는 대기
→ TPS 낮아짐
```

**너무 높게 설정하면:**

```
threads.max=2000
→ 메모리 부족 (2000 * 1MB = 2GB)
→ 컨텍스트 스위칭 과다
→ CPU는 100%인데 처리량은 낮음
```

**적절한 값 찾기:**

```
1. 애플리케이션 로직 복잡도 (CPU 사용률)
2. I/O 대기 시간 (DB, API 호출)
3. 예상 트래픽
4. 하드웨어 스펙 (코어 수, RAM)
5. DBCP 크기 (DB 커넥션 풀)
```

> 출처: [F-lab - 스프링 서버의 스레드 풀 관리](https://f-lab.kr/insight/spring-boot-multithreading-threadlocal-20250402), [Velog - 톰캣 Thread Pool 정리](https://velog.io/@mooh2jj/Tomcat-Thread-Pool-정리)

---

## 스레드 풀 크기 계산 공식

이론적으로는 이 공식을 씁니다:

```
스레드 풀 크기 = CPU 코어 수 × (1 + 대기 시간 / 처리 시간)
```

예를 들어:

```
CPU: 4코어
평균 처리 시간: 100ms
평균 I/O 대기: 900ms (DB 쿼리)

스레드 풀 크기 = 4 × (1 + 900/100)
               = 4 × 10
               = 40
```

하지만 실제로는 **부하 테스트로 찾아야** 합니다. 애플리케이션마다 특성이 다르기 때문입니다.

> 출처: [Medium - 스레드 풀의 적절한 크기](https://medium.com/@10x.developer.kr/스레드-풀의-적절한-크기를-구하는-합리적인-방법-7af84b615623)

---

## 설정 방법

### application.yml

```yaml
server:
  tomcat:
    threads:
      max: 200          # 최대 워커 스레드
      min-spare: 10     # 최소 유지 스레드
    accept-count: 100   # 대기 큐 크기
    max-connections: 8192  # 최대 동시 연결
```

### 버전별 속성명

```
Spring Boot 2.3 이후: server.tomcat.threads.max
Spring Boot 2.3 이전: server.tomcat.max-threads
```

> 출처: [Baeldung - Configuring Thread Pools](https://www.baeldung.com/java-web-thread-pool-config)

---

## 톰캣 버전 히스토리

| 버전 | 출시 연도 | 주요 변경사항 |
|------|-----------|---------------|
| Tomcat 3.0 | 1999 | Apache 재단 첫 릴리즈, BIO 기본 |
| Tomcat 7.x | 2011 | BIO 기본, NIO 옵션 제공 |
| Tomcat 8.0 | 2014 | NIO 기본으로 전환 |
| Tomcat 8.5 | 2016 | BIO 완전 제거, NIO 전용 |
| Tomcat 9.0 | 2017 | Servlet 4.0, HTTP/2 지원 |
| Tomcat 10.1 | 2022 | Jakarta EE 9+ (패키지명 변경) |

> 출처: [Apache Tomcat Versions](https://cwiki.apache.org/confluence/display/TOMCAT/Tomcat+Versions), [endoflife.date - Apache Tomcat](https://endoflife.date/tomcat)

---

## 서버는 언제 터지는가?

### 시나리오 1: OutOfMemoryError - unable to create new native thread

스레드를 너무 많이 만들면 JVM이 터집니다.

```
java.lang.OutOfMemoryError: unable to create new native thread
```

**중요한 사실:** 이건 Heap 메모리 부족이 아닙니다. 스레드는 Heap이 아니라 **OS 네이티브 메모리**에 생성됩니다.

> 출처: [Baeldung - OutOfMemoryError unable to create new native thread](https://www.baeldung.com/java-outofmemoryerror-unable-to-create-new-native-thread)

#### 왜 터지는가?

리눅스는 프로세스당 생성할 수 있는 스레드 개수를 제한합니다.

```bash
# 확인 방법
ulimit -u  # 최대 프로세스/스레드 개수
sysctl kernel.threads-max  # 시스템 전체 최대 스레드

# 예시 출력
ulimit -u: 63488
kernel.threads-max: 131072
```

계산 공식:

```
최대 스레드 수 = 가용 메모리(MB) / 스택 크기(MB)
```

예를 들어:

```
서버 메모리: 4GB
JVM Heap: 2GB (-Xmx2g)
남은 메모리: 2GB
스레드 스택 크기: 1MB (-Xss1m)

이론적 최대 스레드: 2048개
실제 제한: ulimit -u (예: 1024)
→ 1024개까지만 생성 가능
```

> 출처: [Baeldung - Maximum Threads per Process](https://www.baeldung.com/linux/max-threads-per-process), [Stack Overflow - Maximum threads in Linux](https://stackoverflow.com/questions/344203/maximum-number-of-threads-per-process-in-linux)

#### 재현 시나리오

```java
// 서버 터트리기 (절대 따라하지 마세요)
class ThreadBomb {
    public static void main(String[] args) {
        int count = 0;
        try {
            while (true) {
                new Thread(() -> {
                    try {
                        Thread.sleep(Long.MAX_VALUE);
                    } catch (InterruptedException e) {
                    }
                }).start();
                count++;
                System.out.println("Threads: " + count);
            }
        } catch (OutOfMemoryError e) {
            System.err.println("터졌다! " + count + "개 스레드에서 사망");
            // Threads: 12543
            // java.lang.OutOfMemoryError: unable to create new native thread
        }
    }
}
```

### 시나리오 2: 스레드 고갈로 인한 응답 불가

스레드가 부족하면 새 요청을 받지 못합니다.

```
톰캣 설정:
- threads.max: 200
- accept-count: 100
- max-connections: 8192

상황:
1. 200개 스레드 전부 DB 쿼리 대기 중 (각 10초씩)
2. accept-count 큐도 100개 꽉 참
3. 301번째 요청부터는 connection refused
```

**로그:**

```
org.apache.tomcat.util.threads.ThreadPoolExecutor
All threads (200) are currently busy
```

> 출처: [Velog - 톰캣 스레드](https://velog.io/@ejung803/-0bayh7qy)

#### 실제 사례

라이브 스트리밍 서버에서 이런 식으로 터질 수 있습니다:

```java
@RestController
class StreamController {

    @GetMapping("/api/stream/{id}")
    public StreamResponse getStream(@PathVariable Long id) {
        // DB 조회 - 평균 100ms
        Stream stream = streamRepository.findById(id);

        // 외부 API 호출 - 평균 500ms
        User user = oauthClient.getUserInfo(stream.userId);

        // Redis 조회 - 평균 10ms
        ViewCount views = redisTemplate.get(stream.id);

        return new StreamResponse(stream, user, views);
    }
}
```

만약 OAuth API가 느려지면 (500ms → 5000ms):

```
1. 200개 스레드가 전부 OAuth 대기
2. 신규 요청은 큐에서 대기
3. 큐마저 꽉 차면 connection refused
4. 사용자는 "서버 점검 중" 페이지만 봄
```

### 시나리오 3: 메모리 누수로 인한 OOM

스레드가 메모리를 안 놓으면 Heap이 터집니다.

```
java.lang.OutOfMemoryError: Java heap space
```

#### ThreadLocal 누수

ThreadLocal 누수의 실제 위험은 OOM이 아니라, 스레드 풀에서 스레드가 재사용될 때 **이전 요청의 데이터가 남아 보안/로직 오류**를 일으키는 것이다. `remove()`를 호출하지 않으면 다음 요청에서 이전 사용자의 정보를 볼 수 있다.

```java
// 위험한 코드
class UserContext {
    private static final ThreadLocal<User> CURRENT_USER =
        new ThreadLocal<>();

    public static void setUser(User user) {
        CURRENT_USER.set(user);
        // remove() 안 하면 메모리 누수!
    }
}

@RestController
class UserController {

    @GetMapping("/api/user")
    public UserResponse getUser() {
        User user = userService.findUser();
        UserContext.setUser(user); // 설정만 하고
        return new UserResponse(user);
        // remove() 안 함 → 스레드가 재사용될 때 남아있음
    }
}
```

200개 스레드가 각각 User 객체(1KB)를 ThreadLocal에 들고 있으면:

![](/uploads/theory/spring-mvc-thread-pool/threadlocal-memory-count.svg)


> 출처: [madplay - 자바 ThreadLocal 사용법과 주의사항](https://madplay.github.io/post/java-threadlocal)

#### 대기열 무한 증가

```java
// 위험한 코드
@Service
class EventProcessor {
    private final Queue<Event> queue =
        new LinkedBlockingQueue<>(); // 크기 제한 없음!

    @Async
    public void processEvent(Event event) {
        queue.offer(event);
    }
}
```

처리 속도보다 유입 속도가 빠르면:

![](/uploads/theory/spring-mvc-thread-pool/waiting.svg)


> 출처: [blog.ecsimsw - 대기열 사이즈와 OOM 문제](https://www.blog.ecsimsw.com/entry/메모리-누수-확인-메트릭-모니터링과-대기열)

### 시나리오 4: OS 레벨 제한

리눅스 커널 파라미터가 부족하면 터집니다.

```bash
# 주요 커널 파라미터
sysctl kernel.pid_max        # 최대 프로세스 ID
sysctl vm.max_map_count      # 메모리 맵 최대 개수
ulimit -n                    # 파일 디스크립터 최대 개수
```

예시:

```bash
# 기본값 (위험!)
kernel.pid_max = 32768
vm.max_map_count = 65530
ulimit -n = 1024

# 톰캣 threads.max=2000 설정
→ 스레드 2000개 * 소켓 10개 = 20,000 file descriptors 필요
→ ulimit -n (1024) 초과
→ java.io.IOException: Too many open files
```

> 출처: [Unix StackExchange - Thread limits](https://unix.stackexchange.com/questions/343296/what-is-a-limit-for-number-of-threads)

### 해결 방법

**1. 스레드 스택 크기 줄이기:**

```bash
java -Xss512k -jar app.jar
# 1MB → 512KB로 줄이면 2배 더 많은 스레드 생성 가능
```

**2. OS 제한 늘리기:**

```bash
# /etc/security/limits.conf
* soft nofile 65536
* hard nofile 65536
* soft nproc 65536
* hard nproc 65536

# /etc/sysctl.conf
kernel.threads-max = 200000
vm.max_map_count = 262144
```

**3. ThreadLocal 정리:**

```java
@RestController
class UserController {

    @GetMapping("/api/user")
    public UserResponse getUser() {
        try {
            User user = userService.findUser();
            UserContext.setUser(user);
            return new UserResponse(user);
        } finally {
            UserContext.remove(); // 꼭 정리!
        }
    }
}
```

**4. 큐 크기 제한:**

```java
@Configuration
class AsyncConfig {
    @Bean
    public Executor taskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setQueueCapacity(1000); // 크기 제한!
        executor.setRejectedExecutionHandler(
            new ThreadPoolExecutor.CallerRunsPolicy()
        );
        return executor;
    }
}
```

> 출처: [Baeldung - OutOfMemoryError Solutions](https://www.baeldung.com/java-outofmemoryerror-unable-to-create-new-native-thread)

---

## 모니터링 지표

톰캣 스레드 풀을 모니터링할 때 봐야 할 지표입니다:

```
요청 관련:
- requestCount: 처리된 총 요청 수
- processingTime: 누적 처리 시간
- maxTime: 최대 처리 시간

스레드 관련:
- currentThreadsBusy: 현재 사용 중인 스레드
- maxThreads: 최대 스레드 수

리소스 관련:
- HeapMemoryUsage: JVM 메모리 사용량
- CollectionCount: GC 횟수
```

> 출처: [Datadog - Tomcat Performance Metrics](https://www.datadoghq.com/blog/tomcat-architecture-and-performance/)

---

## 정리하면

### 톰캣 스레드 풀 200개의 이유

1. **역사적 배경**: 1999년 서버 환경에서 테스트한 결과 150-200이 적당했고, 그게 지금까지 유지됨
2. **메모리 효율**: 200개 스레드는 3.2MB ~ 200MB 정도로 일반 서버에서 무리 없음
3. **컨텍스트 스위칭**: 과도한 스레드로 인한 CPU 오버헤드 방지
4. **범용성**: 중간 규모 부하와 평범한 하드웨어에서 안정적으로 동작
5. **NIO와의 시너지**: NIO 방식에서는 200개 워커 스레드로도 8192개 동시 연결 처리 가능

### CGI → 서블릿 → NIO의 진화

![](/uploads/theory/spring-mvc-thread-pool/cgi-servlet-nio-evolution.svg)


### 결국 답은

200이라는 숫자는 마법의 값이 아닙니다. **애플리케이션 특성에 맞게 튜닝해야 합니다.**

```
I/O 작업 많으면 (DB 쿼리, API 호출):
→ 스레드 늘려도 됨 (500~1000)

CPU 작업 많으면 (이미지 처리, 암호화):
→ 코어 수 * 2 정도로 제한

동시 접속 만 명 이상:
→ Virtual Threads 고려 (Java 21+)
```

**Virtual Threads (Java 21+):** Virtual Thread는 스택을 수 KB만 사용하여 수백만 개를 생성할 수 있다. Spring Boot 3.2+에서는 `spring.threads.virtual.enabled=true` 설정으로 적용 가능하며, 이 경우 플랫폼 스레드 풀 크기 제한이 더 이상 병목이 되지 않는다. "왜 200개인가"라는 질문 자체가 Virtual Thread 환경에서는 의미를 잃는다.

라이브 스트리밍 서버는 WebSocket, DB 쿼리, OAuth API 호출 전부 I/O bound라 스레드를 늘려도 될 것 같습니다. 부하 테스트 돌려보고 최적값을 찾아봐야겠습니다.

---

## 참고 자료

### 공식 문서

- [Apache Tomcat 8.5 Configuration Reference - HTTP Connector](https://tomcat.apache.org/tomcat-8.5-doc/config/http.html)
- [Apache Tomcat Heritage](https://tomcat.apache.org/heritage.html)
- [Apache Tomcat Migration Guide 8.5](https://tomcat.apache.org/migration-85.html)
- [Apache Tomcat Migration Guide 9.0](https://tomcat.apache.org/migration-9.html)
- [Spring Boot Documentation - Embedded Web Servers](https://docs.spring.io/spring-boot/docs/2.0.x/reference/html/howto-embedded-web-servers.html)

### 기술 블로그 및 아티클

- [Datadog - Understanding the Tomcat architecture and key performance metrics](https://www.datadoghq.com/blog/tomcat-architecture-and-performance/)
- [Baeldung - Configuring Thread Pools for Java Web Servers](https://www.baeldung.com/java-web-thread-pool-config)
- [DZone - How Much Memory Does a Java Thread Take?](https://dzone.com/articles/how-much-memory-does-a-java-thread-take)
- [DZone - Understanding the Tomcat NIO Connector](https://dzone.com/articles/understanding-tomcat-nio)
- [Medium - Tomcat Why 200 Default Threads](https://alpitanand20.medium.com/tomcat-why-just-200-default-threads-febd2411b904)
- [Pearson IT Certification - Servlet and JSP History](https://www.pearsonitcertification.com/articles/article.aspx?p=29786&seqNum=3)

### 한국어 기술 블로그

- [Velog - 스프링부트는 어떻게 다중 유저 요청을 처리할까?](https://velog.io/@sihyung92/how-does-springboot-handle-multiple-requests)
- [HARIL - 1대의 서버 애플리케이션은 최대 몇 개의 동시 요청을 감당할 수 있을까?](https://haril.dev/blog/2023/11/10/Spring-MVC-Traffic-Testing)
- [F-lab - 스프링 서버의 스레드 풀 관리](https://f-lab.kr/insight/spring-boot-multithreading-threadlocal-20250402)
- [Velog - 아파치 톰캣의 NIO Connector 와 BIO Connector에 대해 알아보자](https://velog.io/@cjh8746/아파치-톰캣의-NIO-Connector-와-BIO-Connector에-대해-알아보자)
- [Velog - BIO, NIO Connector Architecture in Tomcat](https://velog.io/@jihoson94/BIO-NIO-Connector-in-Tomcat)
- [Velog - 톰캣 Thread Pool 정리](https://velog.io/@mooh2jj/Tomcat-Thread-Pool-정리)
- [Velog - CGI와 서블릿, JSP의 연관관계](https://velog.io/@suhongkim98/CGI와-서블릿-JSP의-연관관계-알아보기)
- [Velog - Servlet은 어쩌다 탄생되었을까](https://velog.io/@adam2/Servelt은-어쩌다-탄생되었을까)
- [Velog - 톰캣 스레드](https://velog.io/@ejung803/-0bayh7qy)
- [80000coding - 웹 서버와 WAS, CGI](https://80000coding.oopy.io/2352c04e-8f98-4695-a5fe-8c789ee94d98)
- [Medium - 스레드 풀의 적절한 크기를 구하는 합리적인 방법](https://medium.com/@10x.developer.kr/스레드-풀의-적절한-크기를-구하는-합리적인-방법-7af84b615623)
- [madplay - 자바 ThreadLocal 사용법과 주의사항](https://madplay.github.io/post/java-threadlocal)
- [blog.ecsimsw - 대기열 사이즈와 OOM 문제](https://www.blog.ecsimsw.com/entry/메모리-누수-확인-메트릭-모니터링과-대기열)

### 성능 측정 및 벤치마크

- [Eli Bendersky - Measuring context switching and memory overheads for Linux threads](https://eli.thegreenplace.net/2018/measuring-context-switching-and-memory-overheads-for-linux-threads/)
- [Medium - The Performance Impact of Excessive Context Switching](https://serkanerip.medium.com/the-performance-impact-of-excessive-context-switching-a8aa023ba542)

### Stack Overflow 및 커뮤니티

- [Stack Overflow - Java thread memory calculation](https://stackoverflow.com/questions/67068623/java-thread-memory-calculation)
- [Stack Overflow - Tomcat NIO thread pools](https://stackoverflow.com/questions/40722254/tomcat-nio-thread-pools)
- [Stack Overflow - TCP/IP - Solving the C10K with the thread per client approach](https://stackoverflow.com/questions/17593699/tcp-ip-solving-the-c10k-with-the-thread-per-client-approach)
- [Stack Overflow - Why is servlet more efficient than CGI?](https://softwareengineering.stackexchange.com/questions/340673/why-is-a-servlet-more-efficient-than-cgi)
- [Stack Overflow - Tomcat BIO vs NIO Connector](https://stackoverflow.com/questions/11032739/what-is-the-difference-between-tomcats-bio-connector-and-nio-connector)

### 기타 자료

- [Wikipedia - C10k problem](https://en.wikipedia.org/wiki/C10k_problem)
- [Wikipedia - 자바 서블릿](https://ko.wikipedia.org/wiki/자바_서블릿)
- [Apache Tomcat Versions](https://cwiki.apache.org/confluence/display/TOMCAT/Tomcat+Versions)
- [endoflife.date - Apache Tomcat](https://endoflife.date/tomcat)
- [Code Java - Spring Boot version history](https://www.codejava.net/frameworks/spring-boot/spring-boot-version-history)
