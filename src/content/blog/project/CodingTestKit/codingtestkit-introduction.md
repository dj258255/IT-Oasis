---
title: 'CodingTestKit - IDE 안에서 코딩테스트를 완결하다'
description: 코딩테스트 준비의 불편함을 해결하기 위해 IntelliJ와 VS Code에서 문제 가져오기, 로컬 테스트, 제출까지 한 번에 할 수 있는 플러그인을 만들었습니다.
date: 2026-03-01
tags:
  - Retrospective
  - Kotlin
  - TypeScript
  - IntelliJ Plugin
  - VS Code Extension
category: personal/CodingTestKit
coverImage: /uploads/project/CodingTestKit/title.png
draft: false
series: "CodingTestKit"
---

## 프로젝트 소개

CodingTestKit은 **IDE에서 코딩테스트 문제를 가져오고, 테스트하고, 제출하는 올인원 플러그인**입니다.

코딩테스트를 준비하면서 항상 불편했습니다. 문제를 풀려면 브라우저에서 문제를 읽고, IDE에서 코드를 작성하고, 다시 브라우저로 돌아가 제출하는 과정을 반복해야 했습니다. CodingTestKit은 이 모든 과정을 IDE 안에서 해결합니다.

**기간**: 2026.03 - 진행 중
**형태**: 개인 프로젝트
**기술 스택**: Kotlin (IntelliJ), TypeScript (VS Code), Gradle, Node.js

---

## 왜 만들었나?

코딩테스트를 실제 시험처럼 연습하고 싶었습니다. 브라우저에서 문제를 풀면 자동완성도 되고, 다른 탭으로 넘어가기도 쉽고, 시간 관리도 느슨해집니다. IDE 안에서 실전과 동일한 환경을 만들어 연습하고 싶었습니다:
- 자동완성 없이 코딩하기
- 외부 붙여넣기 차단
- 시간 제한 타이머
- 포커스 이탈 감지

이런 **시험 모드** 기능까지 갖춘 올인원 도구를 직접 만들기로 했습니다.

---

## 지원 플랫폼

| 플랫폼 | 문제 가져오기 | 로컬 테스트 | 코드 제출 | 검색 | 랜덤 |
|--------|:---------:|:---------:|:--------:|:----:|:----:|
| **백준 (BOJ)** | O | O | O | O | O |
| **프로그래머스** | O | O | O | O | O |
| **SWEA** | O | O | O | O | O |
| **LeetCode** | O | O | O | O | O |
| **Codeforces** | O | O | O | O | O |

---

## 주요 기능

### 문제 가져오기 & 로컬 테스트

플랫폼과 언어를 선택하고 문제 번호만 입력하면 문제 설명과 테스트 케이스가 자동으로 추출됩니다. 코드를 작성하고 **전체 실행**을 누르면 모든 테스트 케이스가 로컬에서 실행되어 PASS/FAIL 결과를 바로 확인할 수 있고, 각 테스트 케이스별로 **실행 시간(ms)**과 **메모리 사용량**이 함께 표시됩니다.

### 시험 모드

원클릭으로 실전과 동일한 환경을 만들 수 있습니다:
- **자동완성 OFF**: 코드 자동완성 비활성화
- **외부 붙여넣기 차단**: 외부에서 복사한 텍스트 붙여넣기 차단
- **포커스 이탈 감지**: IDE 창에서 포커스가 벗어나면 경고 표시
- **타이머**: 스톱워치, 원형 다이얼 카운트다운, 프로그레스 바, 디지털 시계

### GitHub 연동

백준허브처럼 맞은 문제를 자동으로 GitHub에 푸시합니다. 원클릭 로그인, 레포 선택, 자동/수동 푸시를 지원합니다.

### 문제 번역

한국어 ↔ 영어 원클릭 번역을 지원합니다. 번역 결과는 캐시되어 같은 문제를 다시 번역하지 않으며, Rate Limit 보호가 내장되어 있습니다.

---

## IntelliJ vs VS Code

두 플러그인은 동일한 기능을 제공하되, 각 IDE의 특성에 맞게 구현되어 있습니다.

| 구분 | IntelliJ Plugin | VS Code Extension |
|------|:-:|:-:|
| **언어** | Kotlin + Swing UI | TypeScript + Webview |
| **빌드** | Gradle (IntelliJ Platform SDK) | esbuild + vsce |
| **내장 브라우저** | JCEF | VS Code Webview |
| **Codeforces** | - | O |
| **수학 수식 렌더링** | - | KaTeX |

---

## 설치

### IntelliJ
1. [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/30574-codingtestkit)에서 설치
2. 또는 IntelliJ IDEA > Settings > Plugins > Marketplace에서 "CodingTestKit" 검색

### VS Code
1. VS Code > 확장 (`Ctrl+Shift+X`)에서 "CodingTestKit" 검색
2. 또는 [GitHub Releases](https://github.com/dj258255/codingtestkit-vscode/releases)에서 `.vsix` 다운로드
