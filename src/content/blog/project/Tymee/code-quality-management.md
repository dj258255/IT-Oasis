---
title: '코드 품질 관리에 대하여'
description: Spotless, Checkstyle, SpotBugs, JaCoCo, Codecov를 조합한 무료 코드 품질 관리 파이프라인 구축 과정을 정리한다.
date: 2025-11-29T00:00:00.000Z
tags:
  - Code Quality
  - Spotless
  - Checkstyle
  - SpotBugs
  - JaCoCo
  - Codecov
  - CI/CD
category: personal/Tymee
draft: false
coverImage: "/uploads/project/Tymee/code-quality-management/spotless-config.svg"
series: "Tymee"
---

> 일관성 있는 코드를 유지하고 일정 수준 이상의 품질을 보장하기 위해 도입했습니다.

## 도구 선택

SonarQube(올인원)와 개별 도구 조합을 비교했습니다. SonarQube는 대시보드와 이력 관리가 편하지만, SonarCloud는 private 레포에서 유료이고 SonarQube 셀프호스팅은 4GB+ RAM이 필요합니다. 1인 개발에 private 레포로 운영하는 상황에서 무료로 쓸 수 있는 개별 도구 조합(Spotless + Checkstyle + SpotBugs + JaCoCo + Codecov)을 선택했습니다.

---

## 선택한 도구들

### 1. Spotless - 코드 포맷팅

**역할:** 코드 스타일 자동 통일

IDE 포맷터나 EditorConfig만으로는 Java의 import 순서, 중괄호 위치 같은 언어별 규칙까지 통일하기 어렵습니다. Spotless는 Google Java Format을 Gradle 빌드에 통합해서 CI에서 자동 검증하고, 로컬에서 `./gradlew spotlessApply` 한 번으로 자동 수정됩니다.

**동작 방식:**
```bash
# 포맷팅 검사 (CI에서 실행)
./gradlew spotlessCheck

# 자동 포맷팅 (로컬에서 실행)
./gradlew spotlessApply
```

**설정 (build.gradle.kts):**
![spotless-config](/uploads/project/Tymee/code-quality-management/spotless-config.svg)


---

### 2. Checkstyle - 코딩 컨벤션

**역할:** 코딩 규칙 준수 검사

SpotBugs는 바이트코드 분석으로 **버그 패턴**을 찾고, Checkstyle은 소스코드에서 **코딩 컨벤션**을 검사합니다. 역할이 다르므로 둘 다 사용합니다. PMD(코드 복잡도, 중복 코드 탐지)는 SpotBugs가 일부 역할을 대체하므로 제외했습니다. Google Java Style Guide 기반 규칙을 적용하고, suppressions 파일로 특정 클래스를 예외 처리할 수 있습니다.

**주요 검사 항목:**
- 네이밍 규칙 (camelCase, CONSTANT_CASE)
- import 규칙 (star import 금지, 사용하지 않는 import)
- 블록 규칙 (중괄호 필수, 빈 블록 금지)
- 메서드 길이 (50줄 제한)
- 파라미터 개수 (7개 제한, 생성자 제외)

### Star Import(`import .*`) 금지 이유

![star-import-problem](/uploads/project/Tymee/code-quality-management/star-import-problem.svg)

**왜 금지하는가?**

#### 네임스페이스 충돌

`java.util.Date`와 `java.sql.Date`를 동시에 star import하면 `Date` 클래스가 어느 패키지인지 모호해집니다. 컴파일러가 에러를 내거나, 의도하지 않은 클래스가 사용될 수 있습니다.

#### 의존성 불명확

코드만 보고 어떤 클래스를 실제로 사용하는지 파악할 수 없습니다. 코드 리뷰나 디버깅 시 불편합니다.

#### 라이브러리 업그레이드 위험

라이브러리 새 버전에서 추가된 클래스가 기존 코드의 클래스명과 충돌할 수 있습니다. 명시적 import는 이 위험을 방지합니다.

> 참고: [Google Java Style Guide - Import statements](https://google.github.io/styleguide/javaguide.html#s3.3-import-statements)

**예외:** 테스트 코드의 static import는 가독성을 위해 허용하기도 함
![static-import-exception](/uploads/project/Tymee/code-quality-management/static-import-exception.svg)


**Suppressions:**
DTO, Entity, Config, Test 클래스는 일부 규칙을 완화했습니다. 이들은 구조적으로 많은 필드나 긴 설정을 가질 수밖에 없기 때문입니다.

---

### 3. SpotBugs - 버그 탐지

**역할:** 잠재적 버그 패턴 탐지

FindBugs가 2015년 이후 업데이트가 중단되어 그 후속인 SpotBugs를 선택했습니다. Google의 Error Prone(컴파일 타임 버그 탐지)도 검토했지만, Gradle 설정이 복잡하고 SpotBugs가 더 많은 버그 패턴을 탐지합니다. 바이트코드 분석으로 소스코드만으로는 찾기 어려운 버그를 잡아줍니다.

**탐지하는 버그 유형:**
- Null 포인터 역참조 가능성
- 리소스 누수 (스트림, 커넥션)
- 동시성 문제
- 성능 안티패턴
- 보안 취약점

**설정:**
![spotbugs-config](/uploads/project/Tymee/code-quality-management/spotbugs-config.svg)


**Exclude 설정:**
DTO, Entity의 getter가 가변 객체를 반환하는 경고(EI_EXPOSE_REP)는 의도된 동작이므로 제외했습니다.

---

### 4. JaCoCo - 테스트 커버리지

**역할:** 코드 커버리지 측정 및 검증

Cobertura는 2015년 이후 업데이트가 느려졌고, IntelliJ 내장 커버리지는 IDE에서만 확인 가능합니다. JaCoCo는 Eclipse Foundation에서 관리하면서 최신 Java 버전을 빠르게 지원하고, Gradle 통합과 Codecov 연동이 잘 되어 CI 자동화에 적합합니다.

**커버리지 기준:**
![jacoco-coverage-config](/uploads/project/Tymee/code-quality-management/jacoco-coverage-config.svg)


**왜 60%/70%인가?**

40% 미만은 테스트가 거의 없는 상태고, 60%면 핵심 비즈니스 로직은 테스트된 상태로 초기 프로젝트에서 현실적인 목표입니다. 80%면 대부분의 코드가 테스트된 안정화 단계이고, 100%는 getter/setter까지 모두 테스트해야 하므로 ROI가 낮아 현실적이지 않습니다.

> 참고: [Martin Fowler - Test Coverage](https://martinfowler.com/bliki/TestCoverage.html)

---

### 5. Codecov - 커버리지 대시보드

**역할:** 커버리지 시각화 및 이력 관리

Coveralls도 무료 커버리지 대시보드를 제공하지만, Codecov가 PR 코멘트가 더 깔끔하고 GitHub Actions 통합이 쉽습니다. SonarCloud는 private 레포에서 유료이고, 이미 개별 도구를 쓰고 있어서 커버리지 대시보드만 필요했습니다. Codecov는 개인 프로젝트 무료이고 JaCoCo XML 리포트를 업로드하면 바로 동작합니다.

#### Codecov vs Coveralls 실제 비교

![codecov-vs-coveralls](/uploads/project/Tymee/code-quality-management/codecov-vs-coveralls.png)

위 이미지에서 중요한 차이가 보입니다. Codecov는 비율이 아닌 정확한 줄 수로 표시하고, 패치 밖에서 바뀐 커버리지 여부와 패치 안의 코드 커버리지를 구분해서 보여줍니다.

Coveralls는 커버리지가 올랐는지 내렸는지만 보여줘서 숫자 게임처럼 느껴집니다. 실제로 패치가 모두 커버되는지 확인하려면 웹사이트에 직접 방문해야 합니다. 반면 Codecov는 PR 코멘트에서 패치에 대한 상세 정보를 바로 확인할 수 있습니다.

> 출처: [Codecov vs Coveralls](https://text.youknowone.org/post/144201220021/codecov-vs-coveralls)

**Codecov 제공 기능:**
- PR별 커버리지 변화 시각화
- 커버리지 트렌드 그래프
- 파일/디렉토리별 커버리지 맵
- Slack/GitHub 통합

**가격 정책:**
- Public 레포: 무료
- Private 레포 (1~5명): 무료
- Private 레포 (6명 이상): 유료 플랜

private 레포이지만 혼자 만들고 있으니 무료 범위에 해당합니다.

> 참고: [Codecov Pricing](https://about.codecov.io/pricing/)

**설정 방법:**
1. [codecov.io](https://codecov.io)에서 GitHub 연동
2. Repository Settings > Secrets에 `CODECOV_TOKEN` 추가 (Private 레포는 토큰 필수)
3. `codecov.yml`로 세부 설정

**codecov.yml 파일 위치:**

모노레포 구조에서 `codecov.yml`은 반드시 **레포지토리 루트**에 위치해야 합니다. `backend/` 폴더에 넣으면 인식되지 않습니다.

- 허용 위치: `/`, `/dev/`, `/.github/`
- 서브 디렉토리 (예: `/backend/`)에는 배치 불가

> 참고: [Codecov YAML Reference](https://docs.codecov.com/docs/codecov-yaml)

---

## CI 파이프라인 구조


![ci-pipeline](/uploads/project/Tymee/code-quality-management/ci-pipeline.png)


**단계 분리 이유:**
- 코드 품질 검사가 빠르게 실패하면 빌드 시간 절약
- 어느 단계에서 문제인지 명확히 파악 가능

---

## 로컬 개발 워크플로우

### 커밋 전 검사

```bash
# 포맷팅 자동 적용
./gradlew spotlessApply

# 전체 검사 (CI와 동일)
./gradlew check
```

### IDE 설정 권장

IntelliJ IDEA:
1. File > Settings > Editor > Code Style > Java
2. Scheme 옆 톱니바퀴 > Import Scheme > Google Style

---

## 주요 Gradle 태스크

| 태스크 | 설명 |
|-------|------|
| `spotlessCheck` | 포맷팅 검사 |
| `spotlessApply` | 포맷팅 자동 적용 |
| `checkstyleMain` | 메인 코드 Checkstyle |
| `checkstyleTest` | 테스트 코드 Checkstyle |
| `spotbugsMain` | 메인 코드 SpotBugs |
| `test` | 테스트 실행 |
| `jacocoTestReport` | 커버리지 리포트 생성 |
| `jacocoTestCoverageVerification` | 커버리지 기준 검증 |
| `check` | 위 모든 검사 실행 |

---

## 버전 호환성 (Java 25 + Spring Boot 4)

| 도구 | 버전 | Java 25 지원 | 비고 |
|-----|------|-------------|------|
| Spring Boot | 4.0.1 | O | Java 17~25 공식 지원 |
| Spotless | 7.0.2 | O | Google Java Format |
| Checkstyle | **12.3.0** | O | 10.x는 Java 22까지만 지원 |
| SpotBugs Plugin | **6.4.8** | O | 6.0.x는 Java 25 미지원 |
| SpotBugs Annotations | 4.9.8 | O | |
| JaCoCo | **0.8.14** | O | 0.8.12는 Java 22까지만 지원 |

Java 25 LTS를 사용하려면 위 버전 이상을 사용해야 합니다.

---

## 비용 요약

| 도구 | 비용 | 비고 |
|-----|------|------|
| Spotless | 무료 | Gradle 플러그인 |
| Checkstyle | 무료 | Gradle 내장 |
| SpotBugs | 무료 | Gradle 플러그인 |
| JaCoCo | 무료 | Gradle 내장 |
| Codecov | 무료 | 개인/오픈소스 무료 |
| GitHub Actions | 무료 | Private 레포 2000분/월 |

**총 비용: $0**

---

## 실제 효과

도구를 세팅만 하고 끝나면 의미가 없습니다. 실제로 잡아준 문제들을 정리합니다.

| 도구 | 잡아준 문제 예시 |
|------|-----------------|
| Spotless | PR 리뷰에서 포맷팅 지적이 0건으로 줄었습니다. 코드 리뷰가 로직에만 집중할 수 있게 됨 |
| Checkstyle | star import 3건, 미사용 import 5건+를 CI에서 자동 차단. 네이밍 규칙 위반도 커밋 전에 잡힘 |
| SpotBugs | DTO의 가변 객체 반환(EI_EXPOSE_REP) 경고로 방어적 복사 필요성을 인지. 의도된 동작은 exclude 처리 |
| JaCoCo | 초기에 커버리지 42%에서 시작해서 현재 60%+ 달성. 테스트 안 된 서비스 메서드를 시각적으로 파악 가능 |

핵심은 "버그를 몇 개 잡았다"보다 **코드 리뷰의 기계적 지적을 자동화해서 리뷰 품질을 높인 것**입니다.

---

## 참고 자료

- [Google Java Style Guide](https://google.github.io/styleguide/javaguide.html)
- [Spotless Gradle Plugin](https://github.com/diffplug/spotless)
- [Checkstyle Documentation](https://checkstyle.org/)
- [SpotBugs Documentation](https://spotbugs.github.io/)
- [JaCoCo Documentation](https://www.jacoco.org/jacoco/)
- [Codecov Documentation](https://docs.codecov.com/)
