---
title: '서버 없이 댓글을 달 수 있을까? JavaScript 기반 블로그에 Giscus 붙이기'
description: 'JavaScript 기반 정적 블로그에 Giscus 댓글을 붙이고, 댓글 수와 반응 수를 어디까지 구현할지 판단한 과정을 정리했다.'
category: 'Observability'
pubDate: '2026-08-20'
createdAt: '2026-08-20T18:58:46+09:00'
tags: ['giscus', 'github-discussions', 'comments', 'observability', 'cloudflare-workers', 'astro', 'kubernetes']
---

댓글 기능을 붙이면 일이 끝날 줄 알았다. 실제로는 댓글을 어디에 저장할지, 글 목록에 댓글 수를 보여줄지, 통계를 최신 상태로 유지하려면 서버가 필요한지까지 다시 결정해야 했다.

처음 목표는 단순했다.

> 글을 읽은 사람이 GitHub 계정으로 댓글이나 반응을 남길 수 있게 만들자.

그런데 댓글 수와 반응 수를 홈 화면의 글 카드에도 보여주고 싶다는 요구가 생기면서 선택지가 복잡해졌다. 무료 댓글 기능을 붙여 놓고 별도 API 서버와 캐시까지 운영하는 것이 과연 맞는지 다시 따져 보게 됐다.

이 글은 Giscus를 도입하면서 실제로 구현한 범위, 구현하지 않은 범위, 그리고 언제 별도 통계 서버를 고려할지에 대한 기록이다.

## 기존 블로그에 필요한 것은 댓글 저장소가 아니었다

블로그는 Astro 정적 사이트로 빌드되고, 컨테이너 이미지는 Kubernetes에서 제공된다. 배포는 Git 저장소와 Argo CD를 통해 진행한다.

처음에는 댓글을 직접 저장하려면 PostgreSQL이나 별도 API가 필요하다고 생각했다. 하지만 댓글 데이터를 직접 관리하는 것이 이번 목표는 아니었다. 인증, 댓글 작성, 수정, 삭제, 스팸 대응까지 새로 책임지는 것도 부담이었다.

그래서 GitHub Discussions를 저장소로 사용하는 Giscus를 선택했다. Giscus는 페이지와 GitHub Discussion을 매핑하고, 방문자가 GitHub OAuth를 통해 댓글과 반응을 남기도록 한다. 댓글 데이터는 블로그 Pod의 데이터베이스가 아니라 GitHub Discussions에 남는다. [Giscus 공식 저장소](https://github.com/giscus/giscus)

[![Giscus 공식 저장소 미리보기](/images/blog/giscus-comments-operations-boundary/giscus-repository-preview.png)](https://giscus.app/ko)

Giscus 설정은 [giscus.app/ko](https://giscus.app/ko)에서 저장소와 Discussion 카테고리를 선택한 뒤 생성된 설정값을 블로그에 넣는 방식으로 진행했다.

구조는 다음처럼 단순해졌다.

~~~mermaid
flowchart LR
  Visitor["방문자 브라우저"] --> Blog["Astro 블로그"]
  Blog --> Giscus["Giscus iframe"]
  Giscus --> Discussions["GitHub Discussions"]
~~~

이 구조에서는 댓글 기능을 위해 PostgreSQL PVC, 댓글 API, 사용자 테이블을 추가하지 않아도 된다.

## 실제로 붙인 Giscus 설정

Giscus 설정은 페이지 경로를 Discussion과 연결하는 방식으로 구성했다.

~~~text
repo: GitHub Discussions 저장소
category: Announcements
mapping: pathname
strict: 1
reactions-enabled: 1
lang: ko
loading: lazy
~~~

pathname 매핑을 사용하면 글 상세 URL과 Discussion을 연결할 수 있다. strict=1은 비슷한 제목의 Discussion이 잘못 매칭되는 가능성을 줄이기 위한 설정이다. Giscus는 매핑 방식에 따라 GitHub Discussions 검색 API로 현재 페이지에 대응하는 Discussion을 찾는다. [Giscus 고급 설정](https://github.com/giscus/giscus/blob/main/ADVANCED-USAGE.md)

댓글 영역은 글 본문 뒤에 배치했고, 관련 글 목록은 댓글 영역 아래로 내렸다. 글을 다 읽은 뒤 댓글을 남기고, 그 다음 다른 글로 이동하는 흐름이 더 자연스럽다고 판단했다.

## 처음부터 보이지 않았던 다크 모드 문제

초기 화면에서 사이트는 다크 모드인데 Giscus 입력창은 라이트 모드로 먼저 나타나는 문제가 있었다. 라이트·다크 버튼을 한 번 눌러야 그제야 Giscus가 올바른 색으로 바뀌었다.

원인은 Giscus의 기본 data-theme가 라이트 테마로 고정되어 있었고, 사이트 테마와 iframe 테마를 맞추는 메시지는 iframe이 생성된 뒤에야 전달됐기 때문이다.

처음에는 iframe이 만들어진 뒤 postMessage로 테마를 바꾸는 것만 생각했다.

~~~mermaid
sequenceDiagram
  participant Page as 블로그 페이지
  participant G as Giscus iframe

  Page->>G: 기본 라이트 테마로 로드
  G-->>Page: iframe 생성
  Page->>G: 현재 사이트 테마 전달
  Note over G: 초기 화면에서 잠깐 잘못된 테마가 보임
~~~

이후 로딩 순서를 바꿨다. 페이지의 html[data-theme]를 먼저 읽고, 그 값으로 Giscus 로더 스크립트를 동적으로 생성한다. iframe이 만들어진 뒤에는 기존처럼 MutationObserver와 postMessage로 테마 변경을 계속 동기화한다.

현재 로컬 구현은 다음 두 가지를 모두 처리한다.

- 첫 로딩부터 사이트의 라이트·다크 모드와 같은 테마로 시작
- 사용자가 테마 토글을 누르면 이미 열린 Giscus iframe도 변경

## 댓글 수와 반응 수는 Giscus 자체 UI를 사용하기로 했다

처음에는 Giscus Discussion 메타데이터를 부모 페이지로 전달받아, 글 상세 페이지의 댓글 제목 아래에 댓글 수와 반응 수를 따로 표시했다. 하지만 Giscus 자체 UI에도 이미 `댓글 0개`, `반응 0개`가 표시되기 때문에 같은 정보를 위에서 한 번 더 보여주는 구조가 됐다.

그래서 별도 통계 영역과 `data-emit-metadata` 수신 코드를 제거했다. 현재는 글 하단에 Giscus UI만 두고, 댓글 수와 반응 수는 Giscus가 제공하는 화면에서 확인한다. 댓글 기능을 위해 필요한 정보는 남기면서, 같은 내용을 블로그 레이아웃에서 중복해서 관리하지 않는 선택이다.

## 글 목록 카드에도 넣고 싶어졌다

Giscus 화면에서 수치를 확인할 수 있게 되면서, 홈 화면과 전체 글 목록에도 댓글 N · 반응 N을 넣을지 다시 고민하게 됐다. 여기서 구현 난이도가 달라졌다.

상세 페이지는 현재 보고 있는 페이지의 Giscus UI가 자체적으로 수치를 보여준다. 반면 글 목록은 여러 Discussion의 통계를 한 번에 알아야 한다.

가능한 선택지는 네 가지였다.

### 빌드 시 통계 JSON 생성

GitHub GraphQL API로 Discussion 목록을 조회하고 post path → 댓글 수·반응 수 형태의 JSON을 만든 뒤 Astro 빌드에 포함하는 방법이다.

~~~text
GitHub Actions
  → GitHub GraphQL 조회
  → discussion-stats.json 생성
  → Astro build
  → 이미지 배포
~~~

구현은 가장 단순하지만 다음 배포 전까지 값이 고정된다. 댓글이 오늘 늘어도 다음 빌드가 실행될 때까지 카드에는 이전 값이 남는다.

### 서버/API와 캐시 사용

블로그 카드가 /api/post-stats를 호출하고, API 서버가 GitHub GraphQL API를 조회하는 방식이다. API 응답을 5~15분 캐시하면 최신성과 호출 비용을 절충할 수 있다.

~~~mermaid
sequenceDiagram
  participant Browser as 방문자 브라우저
  participant Blog as 블로그 Pod
  participant API as 통계 API
  participant GitHub as GitHub GraphQL

  Browser->>Blog: HTML과 카드 JavaScript 요청
  Browser->>API: 글 목록 통계 요청
  API->>API: 5~15분 캐시 확인
  API->>GitHub: 캐시 만료 시 Discussion 조회
  GitHub-->>API: 댓글·반응 수
  API-->>Browser: 전체 글 통계 JSON
~~~

Cloudflare Worker를 사용하면 이 API를 별도 Kubernetes Pod 없이 운영할 수 있다. 반대로 Kubernetes 안에 통계 API Pod를 추가하면 Secret, Service, 모니터링, 배포 대상이 늘어난다. GitHub GraphQL API는 Discussions를 조회할 수 있지만 인증 정보는 서버 측에 보관해야 한다. [GitHub Discussions GraphQL API](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions)

### 카드마다 Giscus를 하나씩 삽입

각 글 카드에 숨겨진 Giscus iframe을 하나씩 만들고 메타데이터를 수집하는 방법도 생각할 수 있다. 하지만 카드 수만큼 iframe과 외부 요청이 늘고, Giscus도 전체 글 통계를 위한 방식으로는 GitHub API를 직접 호출하는 방법을 안내한다. [Giscus 공식 답변](https://github.com/orgs/giscus/discussions/113)

### 브라우저에서 GitHub API 직접 호출

브라우저가 GitHub GraphQL API를 직접 호출하면 별도 서버는 필요 없다. 그러나 인증 토큰을 브라우저에 노출해야 하거나, 인증 없이 호출할 경우 Rate Limit에 의존하게 된다. 이 방식은 운영 블로그에는 적합하지 않다고 판단했다.

## 결국 목록 통계를 보류한 이유

빌드 시 JSON은 오래된 값이 될 수 있고, API 방식은 무료 댓글 기능에 별도 운영 계층을 추가한다. 카드에 댓글 수를 표시하는 것이 지금 블로그에서 꼭 필요한 기능인지도 다시 봤다.

현재 블로그에서 더 중요한 기능은 다음이다.

- 글을 읽고 댓글을 남길 수 있는가
- 댓글과 반응이 실제로 저장되는가
- 방문자와 글 조회 수를 확인할 수 있는가
- 댓글 기능 때문에 블로그 운영 복잡도가 불필요하게 커지지 않는가

이 기준에서는 상세 글의 Giscus 댓글과 댓글·반응 수만으로도 충분했다. 글 목록에는 제목, 카테고리, 날짜, 태그를 유지하고, 목록 통계 API는 추가하지 않았다.

무료 기능을 선택해 놓고 별도 서버와 캐시를 운영하면 기능 하나의 편의성이 전체 운영 복잡도를 끌어올릴 수 있다. 수치가 없어서 생기는 불편보다, 수치를 최신 상태로 유지하기 위한 시스템을 관리하는 부담이 더 커질 수 있다.

## 언제 서버를 고려할 것인가

특정 날짜를 정해 무조건 API를 추가하기보다, 다음 조건이 생길 때 재검토하는 편이 낫다.

1. 댓글과 반응이 주 단위로 꾸준히 증가한다.
2. 글 목록을 댓글 수나 반응 수로 정렬하고 싶어진다.
3. 인기 글·참여도 높은 글을 별도로 보여줄 필요가 생긴다.
4. 다음 배포까지 기다리는 통계 지연이 실제 운영 판단을 방해한다.
5. 댓글 통계를 운영자 페이지나 별도 리포트에서 보고 싶어진다.

현실적인 계획은 한 달 정도 실제 댓글 사용 패턴을 관찰한 뒤 위 조건을 확인하는 것이다. 조건이 충족되지 않으면 지금 구조를 유지한다. 충족된다면 그때 다음 순서로 확장한다.

~~~text
1. Cloudflare Worker 또는 Kubernetes API 선택
2. GitHub 토큰을 서버 Secret으로 보관
3. Discussion 통계를 한 번에 조회
4. 5~15분 캐시 적용
5. 글 카드에서 한 번만 API 호출
6. API 장애 시 통계만 숨기고 글 목록은 정상 표시
~~~

## 지금까지의 결론

이번 댓글 기능에서 중요한 것은 “기능을 더 많이 붙이는 것”이 아니었다. 어디까지가 현재 블로그에 필요한 운영 범위인지 정하는 일이었다.

현재 결정은 다음과 같다.

- Giscus로 댓글과 반응을 제공한다.
- 댓글 데이터베이스와 자체 인증 서버는 만들지 않는다.
- 상세 글에서는 Giscus 자체 UI로 댓글과 반응 수를 표시한다.
- 글 목록 카드 통계는 당장 추가하지 않는다.
- 통계가 실제 운영 요구가 되는 시점에 API와 캐시를 검토한다.

댓글 기능은 이미 충분히 작동하고 있다. 서버를 추가할 이유가 생길 때까지는, 서버를 추가하지 않는 것도 하나의 운영 결정이다.

## 참고 문서

- [Giscus](https://github.com/giscus/giscus)
- [Giscus Advanced Usage](https://github.com/giscus/giscus/blob/main/ADVANCED-USAGE.md)
- [Giscus: Is it possible to get comment count?](https://github.com/orgs/giscus/discussions/113)
- [GitHub GraphQL API for Discussions](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions)
- [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
