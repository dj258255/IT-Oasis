---
title: '471줄이라 테스트를 못 쓴다고 적었는데, 틀렸습니다'
description: >-
  반년 전에 "쪼개려면 테스트가 필요한데 471줄이라 테스트를 못 쓴다"고 적어 뒀습니다.
  닭-달걀은 함수 전체에만 성립했습니다. 쪼개고 나니 결함이 셋 나왔고,
  셋 다 되돌림 경로에 있었습니다.
date: 2026-08-26
tags:
  - EduMeet
  - Python
  - Refactoring
  - pytest
  - FastAPI
category: team/EduMeet
coverImage: /uploads/project/EduMeet/EduMeetTitle.png
draft: false
series: "EduMeet"
seriesOrder: 12
---

파이썬 AI 서버에서 백엔드와 통신하는 코드를 떼어낼 때, 옆에 있던 함수 하나는 일부러 두고 이렇게 적어 뒀습니다.

> 테스트 없이 쪼개면 '동작이 바뀌었는지 알 방법이 없는 변경'이 된다.
> 그런데 471줄이라 테스트를 쓸 수가 없다 — **닭-달걀이다.**

`summarize_text_auto`입니다. 471줄, 테스트 0개.

앞 문장은 맞습니다. **뒷 문장이 틀렸습니다.**

## 닭-달걀은 함수 전체에만 성립했습니다

다시 열어서 안을 세어 봤습니다.

| 조각 | 줄수 | 성질 | 먼저 시험할 수 있나 |
|---|---:|---|---|
| `chunk_text` | 9 | 순수 함수 | **가능** |
| `find_kr_font_paths` | 30 | 파일시스템만 | **가능** (`tmp_path`) |
| 마크다운 파싱 | ~90 | 순수 함수로 뗄 수 있다 | **가능** |
| FPDF 그리기 | ~160 | 부수효과 | 스모크만 |
| LLM clean/map/reduce | ~120 | 네트워크 | 클라이언트를 주입하면 가능 |

함수 안에 이미 경계가 있었습니다. 그중 셋은 순수 함수라 **옮기기만 하면 바로 시험할 수 있었습니다.**

쪼갤 수 없어서 테스트를 못 쓴 게 아니라, **쪼갤 순서를 안 정했던 것**입니다. "테스트 먼저"라는 원칙을 함수 단위로만 생각했고, 그 함수가 크니까 막혔다고 결론을 내린 겁니다.

```
ai/main.py                471줄 · 시험 0
        ↓
ai/transcript_chunker.py   28줄 · 시험  8
ai/kr_font.py              55줄 · 시험  9
ai/markdown_blocks.py     115줄 · 시험 19
ai/summary_pdf.py         261줄 · 시험 12
ai/summary_llm.py         198줄 · 시험 17
ai/main.py                 88줄 · 조립만
```

파이썬 테스트 **30 → 96**.

## 파싱과 그리기를 가른 것이 제일 컸습니다

원본은 마크다운을 PDF로 그리는 루프 안에서 **"이 줄이 무슨 블록인가"와 "그것을 어떻게 그리나"를 동시에** 하고 있었습니다.

```python
in_code = False
code_is_math = False
callout = False
while i < len(lines):
    if line.strip().startswith("```"):
        ...  open_code(code_is_math)      # 판정과 FPDF 호출이 같은 자리
```

세 개의 상태를 **FPDF를 부르는 코드가 직접 들고 있었습니다.**

그래서 *"`## 요약` 다음에 오는 불릿은 콜아웃 박스 안인가"*를 확인할 방법이 **PDF를 만들어서 눈으로 여는 것밖에 없었습니다.**

지금은 값을 돌려줍니다.

```python
assert parse_markdown_blocks("## 요약\n- 하나")[1].in_callout is True
```

이 한 줄을 쓸 수 있게 된 것이 이번 작업의 절반입니다.

## ★ 그리고 결함이 셋 나왔습니다

**리팩터링이 찾은 게 아닙니다. 그 리팩터링이 가능하게 만든 테스트가 찾았습니다.**

셋 다 **되돌림(fallback) 경로**에 있었습니다.

### 1. 되돌림 PDF가 존재 이유인 조건에서 죽습니다

원본에는 이런 전제가 깔려 있었습니다 — *"폰트가 없으면 글자가 네모로 나온다."*

아니었습니다.

```
fpdf.errors.FPDFUnicodeEncodingException:
  Character "강" at index 2 in text is outside the range of characters
  supported by the font used: "helvetica"
```

fpdf2 2.7 이후로는 **예외가 납니다.** 그러면 구조가 이렇게 됩니다.

```
markdown_to_pdf  실패
    ↓
plain_pdf (Helvetica)   ← 한글이면 여기서도 똑같이 죽는다
```

**되돌림이 있어야 할 바로 그 조건에서 되돌림도 같이 죽습니다.**

### 2. 그 예외가 요약 전체를 죽였습니다

```
    ↓  summarize_text_auto 의 바깥 except
ok: False               ← summary.md 는 이미 만들어져 있는데도
```

정제도 했고, map/reduce 요약도 끝났고, 마크다운도 파일로 썼습니다. 그런데 PDF 하나 때문에 전부 실패로 반환됩니다.

다시 하려면 **토큰을 처음부터 다시 씁니다.**

더 허탈한 건 업로드 쪽입니다.

```python
files = {}
if pdf_path and os.path.isfile(pdf_path):
    ...
```

**받을 준비는 이미 되어 있었습니다.** PDF가 없어도 마크다운만 올릴 수 있게 짜여 있었는데, 보내는 쪽이 그 앞에서 포기하고 있었습니다.

### 3. 되돌림 PDF는 한 줄짜리 문서에서만 돌았습니다

```
fpdf.errors.FPDFException: Not enough horizontal space to render a single character
```

```python
pdf.multi_cell(0, 6, segment)
```

`multi_cell(0, ...)`의 폭은 **"지금 x부터 오른쪽 여백까지"**입니다. 그런데 fpdf2의 `multi_cell`은 끝나고 x를 셀 오른쪽에 둡니다. 되돌리지 않으면 **두 번째 줄부터 폭이 0에 가까워집니다.**

한 줄이면 통과합니다. 두 줄부터 터집니다.

> **잘 안 도는 길일수록 테스트가 유일한 관측 수단입니다.**
> 되돌림 경로는 정의상 잘 안 돕니다. 그래서 이 셋이 오래 살아 있었습니다.

덤으로 하나 더. *"영문이면 폰트 없이도 되겠지"*도 아니었습니다. 본문이 전부 ASCII여도 `- `를 만나면 `•`를 찍는데, 그 글자가 latin-1 밖입니다.

```python
def test_even_ascii_fails_without_a_unicode_font_because_of_the_bullet():
    assert "•" in str(caught.value)
```

## 한 번도 실행된 적 없던 폴백

같은 try/except가 **세 번 똑같이** 있었습니다.

```python
try:
    resp = oai.responses.create(...)
    ...output_text
except Exception:
    comp = oai.chat.completions.create(...)
    ...choices[0].message.content
```

세 벌이라 고칠 때 하나를 빠뜨리기 쉽고, 무엇보다 **한 번도 실행된 적이 없었습니다.** `responses`가 실패해야 도는 길인데, 471줄 안에서는 그 실패를 만들 자리가 없었으니까요.

한곳으로 모으고 가짜 클라이언트로 두 갈래를 다 지나가게 했습니다. 그러자 폴백에서만 나는 문제도 물어볼 수 있게 됐습니다.

```python
def test_fallback_drops_max_output_tokens():
    """구 API 는 그 인자를 모른다. 넘기면 TypeError 로 폴백까지 실패한다."""
```

### 키가 없어서 못 재던 것을 키 없이 재게 만들었습니다

전에는 함수 안에서 OpenAI 클라이언트를 만들었습니다. 그러면 테스트를 돌릴 때마다 `OPENAI_API_KEY`를 요구하고, 없으면 예외가 나서 **요약 로직을 한 줄도 못 재봅니다.**

이 프로젝트가 AI 서비스를 못 띄우는 이유가 셋인데 그중 하나가 유료 키입니다. 클라이언트를 인자로 받게 바꾸니 그 제약이 테스트에서는 사라졌습니다.

## 옮긴 것과 고친 것을 나눠 적었습니다

| | |
|---|---|
| **그대로 옮김** | `chunk_text`, `find_kr_font_paths`, **프롬프트 문자열 전부**, 블록 판정 순서, 색상값 |
| **고침** | PDF 실패가 요약을 죽이지 않는다, `plain_pdf`의 x 되돌림, `uni=True` 제거 |

프롬프트는 **공백 하나까지** 그대로 뒀습니다. 프롬프트가 바뀌면 결과가 바뀌는데, 그건 테스트로 못 잡습니다.

`uni=True`는 fpdf2 2.5.1부터 무시되는 인자이고 "다음 릴리스에서 제거"가 예고돼 있습니다. `requirements`가 `fpdf2>=2.7,<3`이라 **2.x 안에서 사라질 수 있고**, 그때 `TypeError`로 죽습니다.

## 정리

반년 전에 적어 둔 판단이 틀렸다는 걸 확인하는 게 이번 작업의 시작이었습니다.

> **"쪼갤 수 없다"가 아니라 "쪼갤 순서를 안 정했다"였습니다.**

그리고 순서를 정하고 나니, 미뤄 뒀던 그 함수 안에 **한 번도 안 돌아 본 코드가 셋** 있었습니다.
