---
title: 'DB 커넥션 풀, 왜 필요하고 어떻게 설정해야 할까'
description: JDBC의 매번 커넥션 생성 문제부터 HikariCP의 동작 원리, 적정 커넥션 수 공식, 데드락 방지 전략까지 DB 커넥션 풀을 깊이 있게 정리했습니다.
date: 2025-08-23T00:00:00.000Z
tags:
  - Database
  - Connection Pool
  - HikariCP
  - JDBC
  - Spring Boot
  - Performance
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-connection-pool/cost.svg"
---


스레드 풀을 공부하고 개념을 재정립하고 나니 자연스럽게 또 다른 의문이 생겼습니다. "그럼 DB 커넥션은 어떻게 관리되는 거지?" 스레드 풀이 200개로 제한되어 있다면 DB 커넥션에도 제한이 있을 것 같았습니다. 그래서 DB 커넥션 풀을 파헤쳐 보기로 했습니다.

## 1. 왜 커넥션 풀이 필요할까?

### 1.1 JDBC의 등장과 문제점

1997년, Java에 JDBC(Java Database Connectivity)가 등장했습니다. 드디어 자바에서 데이터베이스를 다룰 수 있게 됐습니다. 하지만 JDBC에는 치명적인 문제가 있었습니다.

```java
// 1997년 스타일 JDBC 코드
class OldSchoolDatabase {
    void insertUser(String name) throws SQLException {
        // 1. DB 연결 생성 (비싸다!)
        Connection conn = DriverManager.getConnection(
            "jdbc:mysql://localhost:3306/mydb",
            "username",
            "password"
        );

        // 2. 쿼리 실행
        Statement stmt = conn.createStatement();
        stmt.executeUpdate("INSERT INTO users VALUES ('" + name + "')");

        // 3. 연결 종료
        stmt.close();
        conn.close(); // 다시 만들어야 함...
    }
}
```

**매번 커넥션을 생성하고 제거하는 비용이 엄청나게 비쌌습니다.** TCP 연결 수립(3-way handshake), DB 인증, 메모리 할당 등 수많은 작업이 필요했기 때문입니다.

> 출처: [Baeldung - A Simple Guide to Connection Pooling in Java](https://www.baeldung.com/java-connection-pooling), [Progress - JDBC Connection Pooling in Java Tutorial](https://www.progress.com/tutorials/jdbc/jdbc-jdbc-connection-pooling)

### 1.2 커넥션 한 번 만드는 데 얼마나 걸릴까?

실제로 DB 커넥션을 생성하는 과정은 다음과 같습니다:

1. **TCP 소켓 연결**: 네트워크를 통해 DB 서버와 3-way handshake
2. **DB 인증**: 사용자 이름/비밀번호 검증
3. **세션 생성**: DB 서버 내부에 세션 객체 할당
4. **메타데이터 로딩**: 데이터베이스 설정, 인코딩 정보 등

이 과정은 **수십 밀리초에서 수백 밀리초**가 걸립니다. 로컬 네트워크에서도 20~50ms 정도 소요됩니다. 만약 초당 1000개의 요청이 들어온다면? 그냥 커넥션 만드는 데만 20초가 걸린다는 뜻입니다. (단일 스레드 직렬 처리를 가정한 계산. 멀티스레드 환경에서는 병렬로 커넥션을 생성하므로 실제 시간은 이보다 짧지만, 오버헤드가 크다는 점은 동일)

```java
// 커넥션 생성 비용 측정
class ConnectionBenchmark {
    public static void main(String[] args) {
        long start = System.currentTimeMillis();

        for (int i = 0; i < 100; i++) {
            try (Connection conn = DriverManager.getConnection(
                "jdbc:mysql://localhost:3306/test", "root", "password")) {
                // 커넥션만 만들고 바로 닫음
            }
        }

        long end = System.currentTimeMillis();
        System.out.println("100개 커넥션 생성 시간: " + (end - start) + "ms");
        // 결과: 약 3000~5000ms (30~50ms per connection)
    }
}
```

### 1.3 커넥션 풀의 탄생

이 문제를 해결하기 위해 **커넥션 풀(Connection Pool)** 개념이 등장했습니다.

```java
// 커넥션 풀의 개념
class SimpleConnectionPool {
    private Queue<Connection> pool = new LinkedList<>();

    // 애플리케이션 시작 시 미리 생성
    public SimpleConnectionPool(int poolSize) {
        for (int i = 0; i < poolSize; i++) {
            pool.add(createNewConnection());
        }
    }

    // 커넥션 빌려주기
    public Connection getConnection() {
        if (pool.isEmpty()) {
            throw new SQLException("커넥션 풀이 비었습니다!");
        }
        return pool.poll();
    }

    // 커넥션 반납
    public void returnConnection(Connection conn) {
        pool.offer(conn);
    }
}
```

**핵심 아이디어**: 커넥션을 미리 만들어 두고 재사용하자!

> 출처: [DigitalOcean - Connection Pooling in Java](https://www.digitalocean.com/community/tutorials/connection-pooling-in-java)

### 1.4 왜 커넥션 풀은 싱글톤으로 만들까?

커넥션 풀 자체를 싱글톤 패턴으로 구현하는 이유는 **커넥션 풀을 만드는 것도 비용이 엄청나게 비싸기 때문**입니다.

#### 커넥션 풀 생성 비용

```java
// 커넥션 풀을 매번 새로 만든다면?
class BadConnectionPoolUsage {
    void processRequest() throws SQLException {
        // 문제: 요청마다 풀을 새로 생성!
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:mysql://localhost:3306/mydb");
        config.setUsername("user");
        config.setPassword("password");
        config.setMaximumPoolSize(10);

        // 풀 생성 시 10개 커넥션을 미리 만듦
        HikariDataSource pool = new HikariDataSource(config);  // 비싸다!

        // 사용
        Connection conn = pool.getConnection();
        // ... 쿼리 실행 ...
        conn.close();

        pool.close();  // 풀을 닫으면 10개 커넥션 모두 종료!
    }
}
```

**문제점**:
- 요청마다 10개의 커넥션을 새로 생성 (각 30~50ms) → **300~500ms 소요**
- 요청이 끝날 때마다 10개의 커넥션을 모두 종료
- 커넥션 풀의 의미가 완전히 사라짐!

#### 싱글톤 패턴으로 해결

```java
// 올바른 방법: 싱글톤으로 하나만 만들기
class ConnectionPoolManager {
    // 애플리케이션 전체에서 딱 1개만 존재!
    private static HikariDataSource dataSource;

    // 애플리케이션 시작 시 한 번만 초기화
    static {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:mysql://localhost:3306/mydb");
        config.setUsername("user");
        config.setPassword("password");
        config.setMaximumPoolSize(10);

        dataSource = new HikariDataSource(config);
        // 여기서 10개 커넥션을 미리 생성 (시작 시 한 번만!)
    }

    public static DataSource getDataSource() {
        return dataSource;
    }
}
```

```java
// 사용하는 곳
@Service
class UserService {
    @Autowired
    private DataSource dataSource;  // 싱글톤 풀 주입

    void processRequest() throws SQLException {
        // 풀에서 커넥션만 빌려옴 (빠름!)
        Connection conn = dataSource.getConnection();
        // ... 쿼리 실행 ...
        conn.close();  // 풀에 반납 (종료 아님!)
    }
}
```

#### Spring의 DataSource 빈

Spring에서는 자동으로 싱글톤으로 관리해 줍니다:

```yaml
# application.yml
spring:
  datasource:
    hikari:
      jdbc-url: jdbc:mysql://localhost:3306/mydb
      username: user
      password: password
      maximum-pool-size: 10
```

```java
@Configuration
public class DataSourceConfig {

    @Bean  // Spring이 싱글톤으로 관리!
    public DataSource dataSource() {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(jdbcUrl);
        config.setUsername(username);
        config.setPassword(password);
        config.setMaximumPoolSize(10);

        // 애플리케이션 시작 시 딱 1번만 실행됨!
        return new HikariDataSource(config);
    }
}
```

#### 비용 비교

**잘못된 방법 (매번 풀 생성)**:
![](/uploads/theory/db-connection-pool/cost.svg)


**올바른 방법 (싱글톤 풀)**:

![](/uploads/theory/db-connection-pool/cost-2.svg)


#### 메모리 관점

```java
// 잘못된 방법: 메모리 낭비
class MemoryWaste {
    void badApproach() {
        // 요청 1: 커넥션 풀 1개 (10개 커넥션) = 20MB
        HikariDataSource pool1 = new HikariDataSource(config);

        // 요청 2: 커넥션 풀 1개 (10개 커넥션) = 20MB
        HikariDataSource pool2 = new HikariDataSource(config);

        // 요청 3: 커넥션 풀 1개 (10개 커넥션) = 20MB
        HikariDataSource pool3 = new HikariDataSource(config);

        // 총 메모리: 60MB + GC 부담 증가
    }
}

// 올바른 방법: 싱글톤
class MemoryEfficient {
    private static HikariDataSource pool = new HikariDataSource(config);
    // 애플리케이션 전체에서 20MB만 사용

    void goodApproach() {
        // 모든 요청이 같은 풀 공유
        Connection conn = pool.getConnection();
    }
}
```

#### 핵심 정리

**커넥션 풀을 싱글톤으로 만드는 이유**:

1. **초기화 비용 절감**: 풀 생성 시 모든 커넥션을 미리 만드는데, 이 과정을 한 번만 하면 됩니다
2. **메모리 효율성**: 하나의 풀만 유지하므로 메모리 사용량이 최소화됩니다
3. **커넥션 재사용 극대화**: 애플리케이션 전체에서 같은 커넥션들을 공유해서 사용합니다
4. **리소스 관리 단순화**: 풀이 하나만 있으면 모니터링과 관리가 쉽습니다

**싱글톤이 아니었다면?**
- 커넥션 풀의 의미가 없어진다 (매번 새로 만들면 일반 커넥션과 다를 게 없음)
- 메모리 폭발과 GC 부담 증가
- DB 서버에 불필요한 커넥션이 과도하게 생성됨

> 출처: [Baeldung - A Simple Guide to Connection Pooling in Java](https://www.baeldung.com/java-connection-pooling), [Singleton Pattern in Connection Pool](https://stackoverflow.com/questions/tagged/singleton+connection-pooling)

## 2. 커넥션 풀의 역사

### 2.1 초기 구현체들 (2000년대 초반)

JDBC 2.0에서 커넥션 풀링을 위한 표준 API가 추가되었고, JDBC 3.0에서는 핵심 API에 포함되었습니다. 하지만 JDBC는 **인터페이스만 제공**했고, 실제 구현은 각 라이브러리가 담당했습니다.

> 출처: [Progress - JDBC Connection Pooling in Java Tutorial](https://www.progress.com/tutorials/jdbc/jdbc-jdbc-connection-pooling), [PostgreSQL JDBC - Connection Pools and Data Sources](https://jdbc.postgresql.org/documentation/datasource/)

#### C3P0 (2001년 경)

가장 오래되고 유명한 커넥션 풀 라이브러리였습니다. 하이버네이트와 함께 많이 사용되었습니다.

```xml
<!-- C3P0 설정 (2000년대 스타일) -->
<c3p0-config>
    <default-config>
        <property name="driverClass">com.mysql.jdbc.Driver</property>
        <property name="jdbcUrl">jdbc:mysql://localhost/test</property>
        <property name="user">root</property>
        <property name="password">password</property>

        <property name="minPoolSize">5</property>
        <property name="maxPoolSize">20</property>
        <property name="acquireIncrement">5</property>
    </default-config>
</c3p0-config>
```

**문제점**:
- 설정이 너무 복잡했습니다
- 잘못 설정하면 성능 이슈나 데드락이 발생했습니다
- 멀티 코어 CPU를 제대로 활용하지 못했습니다 (단일 락 사용)
- 프로젝트가 사실상 중단됨 (2017년 기준 기여자 2명, 커밋 2개)

#### Apache Commons DBCP (2001년)

아파치 재단에서 만든 커넥션 풀이었습니다. 많은 프로젝트에서 사용되었습니다.

**문제점** (DBCP 1.x 기준. DBCP 2.x는 Apache Commons Pool 2 기반으로 상당히 개선되었다):
- 단일 스레드와 락을 사용해 전체 풀을 잠가 스레드 안전성을 보장했습니다
- 느렸고 멀티 코어 CPU를 제대로 활용하지 못했습니다
- HikariCP 저자가 작성한 벤치마크(특정 시나리오)에서 HikariCP 대비 **2,000배 이상 느렸다** (21.75 ops/ms vs 45,289 ops/ms)

#### Tomcat JDBC Pool (2010년)

톰캣 팀이 DBCP의 문제를 개선하기 위해 만든 풀이었습니다.

```java
// Tomcat JDBC Pool 설정
org.apache.tomcat.jdbc.pool.DataSource ds =
    new org.apache.tomcat.jdbc.pool.DataSource();
ds.setUrl("jdbc:mysql://localhost:3306/test");
ds.setDriverClassName("com.mysql.jdbc.Driver");
ds.setUsername("root");
ds.setPassword("password");
ds.setMaxActive(100);
ds.setMaxIdle(10);
```

DBCP보다 성능이 훨씬 좋았지만, 여전히 HikariCP에는 미치지 못했다 (2,329 ops/ms).

> 출처: [Stack Overflow - Connection pooling options with JDBC: DBCP vs C3P0](https://stackoverflow.com/questions/520585/connection-pooling-options-with-jdbc-dbcp-vs-c3p0), [Baeldung - Using c3p0 with Hibernate](https://www.baeldung.com/hibernate-c3p0)

### 2.2 HikariCP의 등장 (2012년)

2012년, Brett Wooldridge는 회사 프로토타입을 만들면서 커넥션 풀이 필요했습니다. 기존 풀들을 사용해 봤지만 로드 테스트 중 데드락과 예외가 계속 발생했습니다.

오픈소스니까 코드를 받아서 고쳐보려고 했는데, **예상보다 수천 줄이나 더 많은 코드**를 발견했습니다. 결국 좌절과 필요성 때문에 직접 만들기로 결심했습니다. 그렇게 HikariCP가 탄생했습니다.

**HikariCP의 설계 철학**:
- **"Fast, simple, reliable"**
- 불필요한 기능을 의도적으로 제외 (미니멀리즘)
- 바이트코드 수준의 최적화
- 제로 오버헤드를 추구
- 약 165KB의 초경량 라이브러리

**성능 차이**:

| 풀 이름 | 성능 (ops/ms) | HikariCP 대비 |
|---------|--------------|---------------|
| HikariCP | 45,289 | 1x (기준) |
| Tomcat JDBC | 2,329 | 19배 느림 |
| DBCP2 | 21.75 | **2,081배 느림** |

> 출처: [jOOQ Blog - Brett Wooldridge Shows What it Takes to Write the Fastest Java Connection Pool](https://blog.jooq.org/jooq-tuesdays-brett-wooldridge-shows-what-it-takes-to-write-the-fastest-java-connection-pool/), [HikariCP Benchmark](https://github.com/brettwooldridge/HikariCP-benchmark)

### 2.3 Spring Boot의 선택 (2018년)

2018년, Spring Boot 2.0부터 **HikariCP를 기본 커넥션 풀로 채택**했습니다. 이전에는 Tomcat JDBC Pool을 사용했습니다.

```yaml
# Spring Boot 2.0+ 기본 설정
spring:
  datasource:
    hikari:
      # HikariCP가 기본이 됨
      maximum-pool-size: 10
      connection-timeout: 30000
```

## 3. HikariCP는 왜 빠를까?

### 3.1 바이트코드 수준의 최적화

Brett Wooldridge는 자바 바이트코드 수준까지 내려가서 최적화했습니다. 몇 가지 예시를 보겠습니다.

#### 불필요한 메서드 호출 제거

```java
// 다른 풀들: ArrayList.get() 사용
Connection conn = connectionList.get(index);
// ArrayList.get()은 범위 체크를 함
public E get(int index) {
    rangeCheck(index); // 불필요한 체크!
    return elementData[index];
}

// HikariCP: FastList 직접 구현
Connection conn = fastList.get(index);
// 범위 체크 없이 직접 접근
public T get(int index) {
    return elementData[index]; // 바로 접근
}
```

#### ConcurrentBag: 락 경합 최소화

```java
// HikariCP의 ConcurrentBag
class ConcurrentBag<T> {
    // 각 스레드가 자기 전용 리스트를 가짐 (락 없음!)
    private ThreadLocal<List<T>> threadList = new ThreadLocal<>();

    // 공유 큐 (백업용)
    private CopyOnWriteArrayList<T> sharedList;

    T borrow() {
        // 1단계: 내 전용 리스트에서 찾기 (락 없음!)
        List<T> list = threadList.get();
        for (T item : list) {
            if (item.compareAndSet(STATE_NOT_IN_USE, STATE_IN_USE)) {
                return item;
            }
        }

        // 2단계: 공유 리스트에서 찾기
        for (T item : sharedList) {
            if (item.compareAndSet(STATE_NOT_IN_USE, STATE_IN_USE)) {
                return item;
            }
        }

        return null;
    }
}
```

**핵심**: 스레드별 전용 리스트를 사용해 락 경합을 최소화했습니다.

> 출처: [HikariCP GitHub](https://github.com/brettwooldridge/HikariCP) - ConcurrentBag 구현, [jOOQ Blog - Brett Wooldridge Shows What it Takes to Write the Fastest Java Connection Pool](https://blog.jooq.org/jooq-tuesdays-brett-wooldridge-shows-what-it-takes-to-write-the-fastest-java-connection-pool/)

### 3.2 불필요한 기능 제거

#### PreparedStatement 캐싱을 하지 않는 이유

HikariCP는 커넥션 풀 레벨의 PreparedStatement 캐싱이 JDBC 스펙과 맞지 않아 버그를 유발할 수 있다고 판단하여 제공하지 않습니다. 대신 JDBC 드라이버 설정(예: MySQL의 `cachePrepStmts=true`, `prepStmtCacheSize=250`)을 사용하라고 권장합니다.

```java
// MySQL Connector/J 드라이버 설정으로 캐싱 활성화
// jdbc:mysql://localhost:3306/mydb?cachePrepStmts=true&prepStmtCacheSize=250
Connection conn = dataSource.getConnection();
PreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE id = ?");
```

HikariCP는 커넥션 풀 레벨에서의 PS 캐싱을 과감히 제거하고, 드라이버 레벨 캐싱에 맡기는 방식을 선택했습니다.

> 출처: [HikariCP GitHub - About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing), [MySQL Connector/J Connection Pooling](https://dev.mysql.com/doc/connector-j/en/connector-j-usagenotes-j2ee-concepts-connection-pooling.html)

## 4. HikariCP 설정 완벽 가이드

### 4.1 기본 설정값

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `maximumPoolSize` | 10 | 최대 커넥션 수 |
| `minimumIdle` | maximumPoolSize와 동일 | 최소 유휴 커넥션 수 |
| `connectionTimeout` | 30초 | 커넥션 획득 대기 시간 |
| `idleTimeout` | 10분 | 유휴 커넥션 제거 시간 |
| `maxLifetime` | 30분 | 커넥션 최대 생존 시간 |
| `keepaliveTime` | 0 (비활성화, HikariCP 4.2.0+에서 추가) | 커넥션 유지 확인 간격 |
| `validationTimeout` | 5초 | 연결 유효성 검사 타임아웃 |

### 4.2 Spring Boot 설정 예시

```yaml
spring:
  datasource:
    hikari:
      # 커넥션 풀 크기
      maximum-pool-size: 20
      minimum-idle: 20

      # 타임아웃
      connection-timeout: 3000        # 3초
      validation-timeout: 1000        # 1초

      # 생명주기
      max-lifetime: 580000            # 9분 40초 (DB wait_timeout보다 짧게)
      idle-timeout: 0                 # 0 = 유휴 만료 없음
      keepalive-time: 30000           # 30초
      # 주의 1: idle-timeout은 max-lifetime보다 '짧을' 때만 의미가 있다
      #         (길면 max-lifetime이 먼저 커넥션을 제거하므로 무의미).
      # 주의 2: 아래 권장대로 minimum-idle == maximum-pool-size(고정 풀)면
      #         HikariCP가 유휴 제거 자체를 비활성화하므로 idle-timeout은 어차피 동작하지 않는다.
      #         그래서 여기선 0으로 명시했다.

      # 기타
      auto-commit: true
      leak-detection-threshold: 60000 # 60초
```

### 4.3 중요한 설정들

#### 4.3.1 maximumPoolSize와 minimumIdle

**권장**: **같은 값으로 설정하라!**

```yaml
hikari:
  maximum-pool-size: 20
  minimum-idle: 20  # 같은 값!
```

**이유**:
- 유휴 커넥션 제한 기능이 동작하지 않도록 하기 위함
- 게임 서버나 라이브 스트리밍 서버처럼 **항상 활성 상태인 시스템**에서는 굳이 커넥션을 줄일 필요가 없다
- 커넥션 증가/감소 과정에서 발생하는 오버헤드를 제거

#### 4.3.2 connectionTimeout

**권장**: **0.5~3초**

```yaml
hikari:
  connection-timeout: 3000  # 3초
```

**이유**:
- 기본값 30초는 너무 길다
- 응답이 없는 것보다는 빨리 에러를 반환하는 게 낫다
- 사용자는 30초를 기다리지 않는다

#### 4.3.3 maxLifetime

**권장**: **DB의 wait_timeout보다 최소 30초 짧게 (HikariCP 공식 권장. 네트워크 지연, 클럭 동기화 문제를 고려)**

```yaml
hikari:
  max-lifetime: 580000  # 9분 40초
```

**이유**:
- MySQL의 기본 `wait_timeout`은 8시간(28800초)
- 하지만 실제 운영에서는 10분(600초) 정도로 설정하는 경우가 많다
- HikariCP의 `max-lifetime`을 DB보다 짧게 설정하면 DB가 먼저 끊는 것을 방지

```sql
-- MySQL에서 wait_timeout 확인
SHOW VARIABLES LIKE 'wait_timeout';

-- wait_timeout 설정 (10분)
SET GLOBAL wait_timeout = 600;
SET GLOBAL interactive_timeout = 600;
```

#### 4.3.4 leakDetectionThreshold

**권장**: **60초**

```yaml
hikari:
  leak-detection-threshold: 60000  # 60초
```

**이유**:
- 너무 짧게 설정하면 정상 트랜잭션도 누수로 오판
- 너무 길게 설정하면 실제 누수를 감지하지 못함
- 60초 정도면 대부분의 정상 트랜잭션은 완료됨

```java
// 누수 발생 예시
@Service
class UserService {
    @Autowired
    private DataSource dataSource;

    void badMethod() throws SQLException {
        Connection conn = dataSource.getConnection();
        // 쿼리 실행
        Statement stmt = conn.createStatement();
        stmt.executeQuery("SELECT * FROM users");

        // 문제: conn.close()를 안 했다!
        // 60초 후 HikariCP가 경고 로그 출력
        // WARN - Connection leak detection triggered
    }
}
```

> 출처: [HikariCP Configuration](https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby) - HikariCP 설정 가이드, [Spring Boot HikariCP](https://docs.spring.io/spring-boot/docs/current/reference/html/data.html#data.sql.datasource.connection-pool)

## 5. 커넥션 풀 크기는 어떻게 정할까?

### 5.1 유명한 공식

HikariCP 위키에 나오는 공식이 있습니다:

```
connections = (core_count × 2) + effective_spindle_count
```

- `core_count`: CPU 코어 수
- `effective_spindle_count`: DB 서버가 동시에 처리할 수 있는 디스크 I/O 수

**예시**:
- 8코어 CPU, HDD 1개 사용
- connections = (8 × 2) + 1 = **17개**

### 5.2 왜 "core_count × 2"일까?

CPU와 디스크/네트워크의 속도 차이 때문입니다.

```
CPU: 1 GHz = 10억 사이클/초
디스크: 100 IOPS = 100번/초
네트워크: 1ms 레이턴시 = 1000번/초

속도 차이: 약 100만 배!
```

CPU가 디스크나 네트워크를 기다리는 동안 **다른 스레드를 처리**할 수 있습니다. 그래서 코어 수보다 많은 커넥션이 필요합니다.

```java
// 커넥션이 작업하는 시간 분석
class ConnectionWorkload {
    void processRequest() {
        // 1. CPU 작업: 0.1ms
        businessLogic();

        // 2. DB 쿼리: 10ms (I/O 대기)
        executeQuery();

        // 3. CPU 작업: 0.1ms
        processResult();

        // 총 시간: 10.2ms
        // 실제 CPU 사용: 0.2ms (약 2%)
        // I/O 대기: 10ms (약 98%)
    }
}
```

CPU가 98% 시간을 놀고 있습니다. 그래서 CPU 코어당 2개 이상의 커넥션이 효율적입니다.

### 5.3 실제로는 어떻게 정할까?

**공식은 참고만 하고, 실제 측정이 중요하다!**

#### 단계 1: 스레드 수 확인

```yaml
server:
  tomcat:
    threads:
      max: 200  # 톰캣 최대 스레드
```

#### 단계 2: 작업당 필요 커넥션 수 확인

```java
@Service
class OrderService {
    @Transactional
    void createOrder(Order order) {
        // 1개의 커넥션만 사용
        orderRepository.save(order);
        itemRepository.updateStock(order.getItemId());
    }
}

@Service
class ComplexService {
    void complexOperation() {
        // 문제: 2개의 커넥션이 필요!
        Connection conn1 = dataSource.getConnection(); // 1번
        // ... 작업 중 ...
        Connection conn2 = dataSource.getConnection(); // 2번
        // 데드락 위험!
    }
}
```

#### 단계 3: 공식 적용

```
pool_size = thread_count × (connections_per_task - 1) + 1
```

**예시**:
- 톰캣 스레드: 200개
- 작업당 커넥션: 1개
- pool_size = 200 × (1 - 1) + 1 = **1개**?!

이 공식은 성능 최적값이 아니라 **데드락 방지를 위한 최소 풀 크기**입니다. 작업당 커넥션이 1개면 데드락이 원리적으로 발생할 수 없으므로 최소 1개로도 동작한다는 의미입니다 (극도로 느리겠지만요).

#### 단계 4: 실제 동시성 고려

톰캣 스레드가 200개라고 해서 **동시에 200개가 모두 DB를 쓰는 건 아닙니다**.

```java
@RestController
class StreamingController {
    @GetMapping("/api/stream/{id}")
    void getStream(@PathVariable Long id) {
        // 1. DB 조회 (커넥션 사용)
        Stream stream = streamRepository.findById(id);

        // 2. 비즈니스 로직 (커넥션 사용 안 함)
        processStream(stream);

        // 3. 캐시 확인 (커넥션 사용 안 함)
        cacheService.get(id);

        // 4. 외부 API 호출 (커넥션 사용 안 함)
        notificationService.send(stream);
    }
}
```

실제로는 **10~20% 정도만 동시에 DB를 사용**한다고 가정하면:
- 200 × 0.2 = **40개**

### 5.4 넷마블의 게임 서버 설정

넷마블 기술 블로그에 따르면, 게임 서버에서는 다음과 같이 설정했습니다:

```yaml
hikari:
  maximum-pool-size: 50  # CPU 코어 수 기준, 성능 테스트로 결정
  minimum-idle: 50       # maximum과 동일
```

**중요한 점**:
- 초기값은 CPU 코어 수로 시작
- **성능 테스트를 통해 조정**
- 모니터링하면서 최적값 찾기

> 출처: [HikariCP GitHub - About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing), [넷마블 - 게임 서버 시스템을 위한 HikariCP 옵션 및 권장 설정](https://netmarble.engineering/hikaricp-options-optimization-for-game-server/), [Carrey's 기술블로그 - HikariCP Maximum Pool Size 설정 시 고려해야할 부분](https://jaehun2841.github.io/2020/01/27/2020-01-27-hikaricp-maximum-pool-size-tuning/)

## 6. 언제 서버가 터질까?

### 6.1 시나리오 1: 커넥션 풀 고갈

**상황**: 갑자기 트래픽이 몰렸다.

```java
// 설정
hikari:
  maximum-pool-size: 10
  connection-timeout: 3000  // 3초

// 상황
// 1초에 100개 요청 들어옴
// 각 요청은 DB 쿼리에 5초 소요

// 1초 후: 100개 요청이 10개 커넥션을 대기
// 90개 요청이 큐에서 대기
// 3초 후: connection-timeout 발생!

// 로그
org.springframework.dao.DataAccessResourceFailureException:
  Unable to acquire JDBC Connection
Caused by: java.sql.SQLTransientConnectionException:
  HikariPool-1 - Connection is not available,
  request timed out after 3000ms.
```

**해결**:

1. **커넥션 풀 크기 증가**
```yaml
hikari:
  maximum-pool-size: 50  # 10 → 50
```

2. **쿼리 최적화**
```sql
-- Before: 5초
SELECT * FROM streams WHERE status = 'LIVE';

-- After: 0.1초 (인덱스 추가)
CREATE INDEX idx_stream_status ON streams(status);
SELECT * FROM streams WHERE status = 'LIVE';
```

3. **캐싱 도입**
```java
@Service
class StreamService {
    @Cacheable("liveStreams")
    List<Stream> getLiveStreams() {
        // DB 조회 횟수 감소
        return streamRepository.findByStatus(StreamStatus.LIVE);
    }
}
```

### 6.2 시나리오 2: 커넥션 누수

**상황**: 커넥션을 반환하지 않았다.

```java
@Service
class BadService {
    @Autowired
    private DataSource dataSource;

    void leakyMethod() throws SQLException {
        Connection conn = dataSource.getConnection();
        Statement stmt = conn.createStatement();
        ResultSet rs = stmt.executeQuery("SELECT * FROM users");

        // 처리...

        // 문제: close()를 안 했다!
        // conn, stmt, rs가 모두 닫히지 않음
    }
}

// 이 메서드를 10번 호출하면?
// 커넥션 풀(10개)이 모두 고갈됨!
```

**증상**:
```
WARN - Connection leak detection triggered for connection
```

**해결**:

1. **try-with-resources 사용** (Java 7+)
```java
@Service
class GoodService {
    @Autowired
    private DataSource dataSource;

    void goodMethod() throws SQLException {
        try (Connection conn = dataSource.getConnection();
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery("SELECT * FROM users")) {

            // 처리...

        } // 자동으로 close() 호출!
    }
}
```

2. **JPA/MyBatis 사용**
```java
@Service
class BetterService {
    @Autowired
    private UserRepository userRepository;

    void betterMethod() {
        // JPA가 알아서 커넥션 관리
        List<User> users = userRepository.findAll();
    }
}
```

3. **누수 감지 설정**
```yaml
hikari:
  leak-detection-threshold: 60000  # 60초
```

### 6.3 시나리오 3: DB 서버가 커넥션을 끊어버림

**상황**: MySQL의 `wait_timeout`이 만료되었다.

```sql
-- MySQL 기본 설정
SHOW VARIABLES LIKE 'wait_timeout';
-- wait_timeout = 28800 (8시간)

-- 하지만 실제 운영에서는 짧게 설정하는 경우가 많음
SET GLOBAL wait_timeout = 60;  -- 60초로 변경
```

```java
// 1. 커넥션 획득
Connection conn = dataSource.getConnection();

// 2. 아무것도 안 하고 70초 대기
Thread.sleep(70000);

// 3. 쿼리 실행 시도
stmt.executeQuery("SELECT * FROM users");
// 에러!
// Communications link failure
// The last packet successfully received from the server
// was 70,000 milliseconds ago
```

**해결**:

1. **HikariCP maxLifetime 설정**
```yaml
hikari:
  max-lifetime: 50000  # 50초 (wait_timeout보다 짧게)
```

2. **DB wait_timeout 증가**
```sql
SET GLOBAL wait_timeout = 600;           -- 10분
SET GLOBAL interactive_timeout = 600;    -- 10분
```

3. **keepaliveTime 설정** (HikariCP 4.2.0+)
```yaml
hikari:
  keepalive-time: 30000  # 30초마다 연결 확인
```

**keepaliveTime의 원리**:
```java
// HikariCP 내부 동작
class HikariPool {
    void keepalive() {
        for (Connection conn : idleConnections) {
            if (idleTime > keepaliveTime) {
                // 간단한 쿼리로 연결 확인
                conn.isValid(validationTimeout);
                // 또는
                stmt.execute("SELECT 1");
            }
        }
    }
}
```

> 출처: [후덥의 기술블로그 - HikariCP는 test-while-idle과 같은 커넥션 갱신 기능이 없을까?](https://pkgonan.github.io/2018/04/HikariCP-test-while-idle), [SK C&C - MySql/MariaDB에서 발생하는 Connection 끊김 문제 해결하기](https://engineering-skcc.github.io/cloud/tomcat/apache/performancetest/MySqlDBWaitTimeOut/)

### 6.4 시나리오 4: 데드락

**상황**: 커넥션 풀이 부족해서 데드락 발생.

```java
@Service
class DeadlockService {
    @Transactional
    void problemMethod() {
        // 첫 번째 커넥션 획득
        Connection conn1 = dataSource.getConnection();

        // ... 작업 중 ...

        // 두 번째 커넥션 시도
        // 하지만 풀에 남은 커넥션이 없음!
        Connection conn2 = dataSource.getConnection();
        // 영원히 대기... (데드락!)
    }
}
```

**발생 조건**:
![](/uploads/theory/db-connection-pool/64-4.svg)


**해결**:

1. **풀 크기 공식 적용**
```yaml
# pool_size = thread_count × (connections_per_task - 1) + 1
# 16 × (2 - 1) + 1 = 17

hikari:
  maximum-pool-size: 17
```

2. **작업당 커넥션 수 줄이기**
```java
@Service
class FixedService {
    @Transactional
    void fixedMethod() {
        // 하나의 트랜잭션으로 통합
        // 1개의 커넥션만 사용
        orderRepository.save(order);
        itemRepository.updateStock(itemId);
    }
}
```

### 6.5 시나리오 5: 메모리 부족

**상황**: 커넥션이 너무 많아서 메모리 부족.

```java
// 커넥션 하나당 메모리 사용량
class ConnectionMemory {
    // TCP 소켓: ~64KB
    // ResultSet 버퍼: ~1MB
    // Statement 객체들: ~100KB
    // 메타데이터: ~100KB

    // 총합: 약 1~2MB per connection
}

// 커넥션 1000개 = 1~2GB 메모리!
hikari:
  maximum-pool-size: 1000  // 위험!
```

**해결**:

1. **적절한 풀 크기 유지**
```yaml
hikari:
  maximum-pool-size: 50  # 적정 수준
```

2. **DB 서버 리소스 확인**
```sql
-- MySQL 최대 커넥션 확인
SHOW VARIABLES LIKE 'max_connections';
-- max_connections = 151 (기본값)

-- 현재 커넥션 확인
SHOW STATUS LIKE 'Threads_connected';
```

3. **애플리케이션 서버 분산**
```yaml
# 서버 1대: 커넥션 50개
# 서버 3대: 커넥션 150개
# DB max_connections: 200

# 여유 있게 설정
```

## 7. 실제 장애 사례

### 7.1 카카오페이: R2DBC 커넥션 풀 미생성

**문제**: Spring WebFlux + R2DBC에서 jar 파일 실행 시 커넥션 풀이 초기화되지 않음.

```kotlin
// r2dbc-pool의 특성
// 생성 시점에 커넥션을 만들지 않고,
// 실제 필요할 때 만듦 (Lazy Initialization)

// IntelliJ에서는 동작함 (왜?)
// → Actuator의 HealthCheck가 JMX를 통해 자동 호출
// → 이 과정에서 커넥션 풀이 초기화됨

// jar 실행 시에는 동작 안 함
// → HealthCheck가 자동 호출되지 않음
// → 커넥션 풀이 초기화 안 됨
// → 첫 요청에서 지연 발생!
```

**해결**:
```kotlin
// 명시적으로 warmup 호출
r2dbcPool.warmup().block()
```

**교훈**:
- 개발 환경과 운영 환경의 차이를 검증해야 합니다
- IDE의 자동화 기능이 실제 동작을 왜곡할 수 있습니다
- 새로운 기술 도입 시 기대 동작과 실제 동작을 확인해야 합니다

### 7.2 SK C&C: MySQL wait_timeout 문제

**문제**: `wait_timeout`을 60초로 짧게 설정해서 커넥션이 계속 끊김.

```sql
-- 잘못된 설정
SET GLOBAL wait_timeout = 60;  -- 너무 짧음!
```

```java
// 60초마다 커넥션이 끊김
// HikariCP가 끊긴 커넥션을 감지하지 못함
// 애플리케이션에서 에러 발생!

// 에러 로그
Communications link failure
The last packet successfully received from the server
was 70,000 milliseconds ago
```

**해결**:
```yaml
# HikariCP 설정
hikari:
  max-lifetime: 50000  # 50초 (wait_timeout보다 짧게)

# MySQL 설정
wait_timeout: 180      # 3분
```

**교훈**:
- DB 타임아웃 설정은 신중하게 해야 합니다
- HikariCP의 `max-lifetime`은 DB `wait_timeout`보다 짧게 설정해야 합니다
- 너무 짧은 타임아웃은 성능 저하를 유발합니다

### 7.3 개인 프로젝트: 커넥션 누수

**문제**: `leak-detection-threshold`를 2초로 설정해서 오탐 발생.

```yaml
# 잘못된 설정
hikari:
  leak-detection-threshold: 2000  # 2초 (너무 짧음!)
```

```java
@Service
class SchedulerService {
    @Scheduled(fixedDelay = 1000)
    void scheduledTask() {
        // 정상적인 작업인데 3초 소요
        userRepository.findAll();  // 3초

        // HikariCP가 누수로 오판!
        // WARN - Apparent connection leak detected
    }
}
```

**해결**:
```yaml
hikari:
  leak-detection-threshold: 60000  # 60초
```

**교훈**:
- 너무 짧은 누수 감지 시간은 오탐을 유발합니다
- 정상 트랜잭션 처리 시간을 고려해야 합니다
- 60초 정도가 적절합니다

### 7.4 생산성 저하: MySQL AbandonedConnectionCleanupThread

**문제**: DB 커넥션이 이상하게 많이 생성되어 메모리 사용량 증가.

```java
// MySQL Connector/J의 문제
// AbandonedConnectionCleanupThread가 계속 생성됨
// 메모리 누수 발생!

// Thread Dump
"MySQL-AB-1" daemon
"MySQL-AB-2" daemon
"MySQL-AB-3" daemon
... (수백 개)
```

**해결**:
```properties
# JVM 옵션 추가
-Dcom.mysql.cj.disableAbandonedConnectionCleanup=true
```

**교훈**:
- 일반 서비스는 커넥션을 직접 관리하지 않습니다
- JDBC 드라이버의 자동 정리 기능이 오히려 해가 될 수 있습니다
- 불필요한 기능은 비활성화해야 합니다

> 출처: [카카오페이 - R2DBC Connection Pool 실종 사건](https://tech.kakaopay.com/post/r2dbc-connection-pool-missing/), [SK C&C - MySql/MariaDB에서 발생하는 Connection 끊김 문제 해결하기](https://engineering-skcc.github.io/cloud/tomcat/apache/performancetest/MySqlDBWaitTimeOut/), [velog - DB 커넥션 풀 누수 문제](https://velog.io/@dev_tmb/DB-커넥션-풀-누수-문제)

## 8. 모니터링과 최적화

### 8.1 HikariCP 메트릭

HikariCP는 다양한 메트릭을 제공합니다.

```yaml
# Actuator 설정
management:
  endpoints:
    web:
      exposure:
        include: metrics,health
  metrics:
    enable:
      hikaricp: true
```

```java
// 확인 가능한 메트릭
hikaricp.connections.active      // 활성 커넥션 수
hikaricp.connections.idle        // 유휴 커넥션 수
hikaricp.connections.pending     // 대기 중인 요청 수
hikaricp.connections.timeout     // 타임아웃 발생 횟수
hikaricp.connections.usage       // 커넥션 사용 시간
```

### 8.2 Prometheus + Grafana

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'spring-app'
    metrics_path: '/actuator/prometheus'
    static_configs:
      - targets: ['localhost:8080']
```

**알아야 할 지표**:
- **active / maximum**: 80% 넘으면 풀 크기 증가 고려
- **pending**: 0이 아니면 풀 부족
- **timeout**: 계속 발생하면 쿼리 최적화 또는 풀 증가 필요
- **usage**: 평균 사용 시간이 길면 쿼리 최적화 필요

### 8.3 최적화 체크리스트

#### 1단계: 설정 확인
- [ ] `maximumPoolSize` = `minimumIdle`로 설정했는가?
- [ ] `connectionTimeout`을 3초 이하로 설정했는가?
- [ ] `maxLifetime` < DB `wait_timeout`인가?
- [ ] `leakDetectionThreshold`를 60초로 설정했는가?

#### 2단계: 코드 확인
- [ ] try-with-resources를 사용하는가?
- [ ] JPA/MyBatis를 사용하는가? (직접 JDBC 사용 지양)
- [ ] 한 트랜잭션에서 여러 커넥션을 사용하지 않는가?

#### 3단계: 쿼리 최적화
- [ ] 슬로우 쿼리를 찾았는가?
- [ ] 인덱스를 적절히 사용하는가?
- [ ] N+1 쿼리 문제를 해결했는가?

#### 4단계: 모니터링
- [ ] HikariCP 메트릭을 수집하는가?
- [ ] 알람을 설정했는가? (active > 80%, timeout > 0)
- [ ] DB 서버 모니터링도 하는가?

## 9. 정리

### 9.1 핵심 요약

1. **커넥션 생성은 비싸다** (20~50ms)
   - 커넥션 풀로 재사용하자

2. **HikariCP가 최고다**
   - Spring Boot 2.0+의 기본 풀
   - 다른 풀보다 **수천 배** 빠르다

3. **설정이 중요하다**
   - `maximumPoolSize` = `minimumIdle`
   - `connectionTimeout` = 3초
   - `maxLifetime` < DB `wait_timeout`

4. **풀 크기 공식**
   ```
   connections = (core_count × 2) + effective_spindle_count
   ```
   하지만 실제 측정이 더 중요!

5. **주요 장애 원인**
   - 커넥션 풀 고갈
   - 커넥션 누수 (close 안 함)
   - DB 타임아웃
   - 데드락

6. **해결 방법**
   - try-with-resources 사용
   - JPA/MyBatis 사용
   - 쿼리 최적화
   - 모니터링

### 9.2 실제 설정 예시

```yaml
# 라이브 스트리밍 서버 설정
spring:
  datasource:
    hikari:
      # 커넥션 풀
      maximum-pool-size: 50
      minimum-idle: 50

      # 타임아웃
      connection-timeout: 3000
      validation-timeout: 1000

      # 생명주기
      max-lifetime: 580000    # 9분 40초
      idle-timeout: 600000    # 10분
      keepalive-time: 30000   # 30초

      # 누수 감지
      leak-detection-threshold: 60000

# MySQL 설정
# wait_timeout = 600 (10분)
# interactive_timeout = 600 (10분)
```

### 9.3 마치며

스레드 풀에 이어 커넥션 풀까지 공부하고 나니, 이제 라이브 스트리밍 서버가 어떻게 동시 요청을 처리하는지 전체 그림이 보이기 시작했습니다.

![](/uploads/theory/db-connection-pool/93.svg)


다음엔 캐싱과 비동기 처리를 더 공부해서, CS 개념을 재정립하고 더 빠르고 안정적인 서버를 만들도록 노력해야겠습니다.

## 참고 자료

### 공식 문서
- [HikariCP GitHub](https://github.com/brettwooldridge/HikariCP) - HikariCP 공식 저장소
- [HikariCP Configuration](https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby) - HikariCP 설정 가이드
- [MySQL Connector/J Connection Pooling](https://dev.mysql.com/doc/connector-j/en/connector-j-usagenotes-j2ee-concepts-connection-pooling.html) - MySQL JDBC 커넥션 풀링
- [Apache Tomcat JDBC Pool](https://tomcat.apache.org/tomcat-7.0-doc/jdbc-pool.html) - Tomcat JDBC Pool 문서
- [PostgreSQL JDBC Connection Pools](https://jdbc.postgresql.org/documentation/datasource/) - PostgreSQL JDBC 커넥션 풀
- [Spring Boot HikariCP](https://docs.spring.io/spring-boot/docs/current/reference/html/data.html#data.sql.datasource.connection-pool) - Spring Boot 공식 문서

### 기술 블로그
- [넷마블 - 게임 서버 시스템을 위한 HikariCP 옵션 및 권장 설정](https://netmarble.engineering/hikaricp-options-optimization-for-game-server/) - 게임 서버 최적화 사례
- [카카오페이 - R2DBC Connection Pool 실종 사건](https://tech.kakaopay.com/post/r2dbc-connection-pool-missing/) - R2DBC 커넥션 풀 장애 사례
- [SK C&C - MySql/MariaDB에서 발생하는 Connection 끊김 문제 해결하기](https://engineering-skcc.github.io/cloud/tomcat/apache/performancetest/MySqlDBWaitTimeOut/) - wait_timeout 문제 해결
- [Carrey's 기술블로그 - HikariCP Maximum Pool Size 설정 시 고려해야할 부분](https://jaehun2841.github.io/2020/01/27/2020-01-27-hikaricp-maximum-pool-size-tuning/) - 데드락 방지를 위한 풀 크기 계산
- [후덥의 기술블로그 - HikariCP는 test-while-idle과 같은 커넥션 갱신 기능이 없을까?](https://pkgonan.github.io/2018/04/HikariCP-test-while-idle) - HikariCP 커넥션 관리 방식
- [jOOQ Blog - Brett Wooldridge Shows What it Takes to Write the Fastest Java Connection Pool](https://blog.jooq.org/jooq-tuesdays-brett-wooldridge-shows-what-it-takes-to-write-the-fastest-java-connection-pool/) - HikariCP 개발 스토리

### 한글 자료
- [hudi.blog - 데이터베이스 커넥션 풀 (Connection Pool)과 HikariCP](https://hudi.blog/dbcp-and-hikaricp/) - 커넥션 풀 기본 개념
- [velog - DB 커넥션 풀 누수 문제](https://velog.io/@dev_tmb/DB-커넥션-풀-누수-문제) - 누수 감지 설정 문제
- [haon.blog - HikariCP 와 데이터베이스 커넥션 풀(DBCP) 최적화 고민하기](https://haon.blog/database/hikaricp-theory/) - 커넥션 풀 최적화 이론
- [Baeldung - A Simple Guide to Connection Pooling in Java](https://www.baeldung.com/java-connection-pooling) - Java 커넥션 풀링 가이드
- [Progress - JDBC Connection Pooling in Java Tutorial](https://www.progress.com/tutorials/jdbc/jdbc-jdbc-connection-pooling) - JDBC 커넥션 풀링 튜토리얼

### 벤치마크
- [HikariCP Benchmark](https://github.com/brettwooldridge/HikariCP-benchmark) - HikariCP 공식 벤치마크
- [Medium - Database Connection Pool Analysis](https://medium.com/@jeevanpaatil/database-connection-pool-analysis-92d50ba4bd06) - 커넥션 풀 성능 비교
