---
title: 'Giscus 댓글이 달리면 Discord에 뜨게 만들었다'
description: 'GitHub Discussions에 저장되는 Giscus 댓글을 GitHub Actions로 받아, 실제 블로그 글 링크와 함께 Discord Embed 알림으로 보내는 설정 과정과 지연 시간을 정리했다.'
category: 'Automation'
pubDate: '2026-08-20'
createdAt: '2026-08-20T21:04:28+09:00'
tags: ['giscus', 'github-discussions', 'github-actions', 'discord', 'webhook', 'astro', 'automation']
---

댓글 기능을 붙이고 나니 다음 문제가 남았다.

> 누군가 댓글을 남겼다는 사실을 블로그를 열어보지 않고 알 수 있을까?

블로그는 Astro로 빌드한 정적 사이트이고, 댓글은 Giscus를 통해 GitHub Discussions에 저장하고 있다. 댓글 저장을 위해 별도 API 서버를 만들고 싶지는 않았다. 대신 GitHub에서 댓글 이벤트가 발생하면 GitHub Actions가 Discord로 알림을 보내도록 구성했다.

최종 목표는 단순한 GitHub 알림이 아니었다.

- 어떤 글에 댓글이 달렸는지 표시
- 댓글 작성자와 본문 표시
- GitHub 댓글 링크 제공
- Discord에서 실제 블로그 글로 바로 이동
- 댓글이 달린 뒤 몇 초 안에 알림 도착

이 글은 이 흐름을 실제로 구성하고, 중간에 왜 알림이 세 개나 왔는지까지 확인한 기록이다.

## 출발점: Giscus는 댓글을 저장하지만 알림은 보내지 않는다

Giscus는 블로그에 댓글 UI를 삽입하는 서비스다. 실제 댓글 데이터는 블로그 Pod나 PostgreSQL이 아니라 GitHub Discussions에 저장된다. 페이지 경로와 Discussion을 연결하므로, 댓글이 달리는 위치는 다음과 같다.

~~~mermaid
flowchart LR
  Visitor["방문자"] --> Blog["Astro 블로그"]
  Blog --> Giscus["Giscus iframe"]
  Giscus --> Discussion["GitHub Discussion"]
~~~

이 구조는 댓글 저장과 인증을 새로 운영하지 않아도 된다는 장점이 있다. 하지만 GitHub Discussion에 새 댓글이 생겼다고 해서 블로그 운영자에게 별도 알림이 자동으로 오지는 않는다.

Giscus를 붙인 과정은 [서버 없이 댓글을 달 수 있을까? JavaScript 기반 블로그에 Giscus 붙이기](/blog/giscus-comments-operations-boundary/)에 정리했다. 이번 글에서는 그 다음 문제인 **댓글 알림**만 다룬다.

## 처음 선택한 방법: GitHub Webhook에서 Discord로 직접 보내기

가장 먼저 떠올린 방법은 Discord의 GitHub 호환 Webhook이었다.

~~~mermaid
flowchart LR
  GitHub["GitHub Discussions"] -->|discussion_comment| Discord["Discord /github Webhook"]
~~~

Discord Webhook URL 뒤에 `/github`를 붙이고, GitHub 저장소의 `Settings → Webhooks`에서 `Discussion comment` 이벤트를 선택하면 된다. 이 방식은 블로그 코드나 Kubernetes를 전혀 건드리지 않는다. [Discord Webhook 문서](https://docs.discord.com/developers/resources/webhook)

설정 중 처음 받은 오류는 다음과 같았다.

~~~json
{"_misc":["Expected \"Content-Type\" header to be one of {'application/json'}."]}
~~~

GitHub의 테스트 요청은 `ping` 이벤트였고, 요청 헤더의 Content-Type이 `application/x-www-form-urlencoded`였다. Discord GitHub Webhook은 `application/json`을 요구하므로 GitHub Webhook 설정을 수정했다.

그 뒤 실제 댓글을 작성하자 알림은 도착했다. 다만 형식은 Discord가 정해 둔 형식이었다.

~~~text
[kimgunwooo/blog] New comment on discussion #3: blog/giscus-comments-operations-boundary/
테스트
~~~

글 제목과 댓글은 표시되지만, Embed 디자인이나 실제 블로그 링크를 원하는 방식으로 구성하기는 어려웠다. GitHub 호환 Webhook에는 메시지 템플릿을 바꾸는 설정이 없기 때문이다.

## 알림이 세 개 온 이유

커스텀 알림을 만들기 위해 Workflow를 저장소에 추가하고 Push했더니 Discord에 알림이 세 개 도착했다.

### 첫 번째: GitHub 앱의 Push 알림

첫 번째 알림은 다음과 같은 형태였다.

~~~text
[blog:main] 1 new commit
feat: notify Discord on blog comments
~~~

이것은 댓글 알림이 아니었다. Discord 서버에 연결해 둔 GitHub 앱이 저장소의 커밋을 감시하고 있었고, Workflow 파일을 Push한 커밋을 알려준 것이다.

GitHub 저장소의 Webhook 목록을 확인했을 때 이 알림을 만드는 Hook은 없었다. 따라서 이 알림은 GitHub 저장소 Webhook이 아니라 Discord의 `Server Settings → Integrations`에 연결된 GitHub 앱에서 발생한 것으로 판단했다.

커밋 알림이 필요하지 않다면 Discord 서버의 GitHub Integration에서 `kimgunwooo/blog` 구독을 제거하거나 Push 이벤트를 끄면 된다. Discord의 Integrations 화면은 서버에 연결된 앱과 Webhook을 관리하는 곳이다. [Discord Server Integrations](https://support.discord.com/hc/en-us/articles/360045093012-Server-Integrations-Page)

### 두 번째: 기존 직접 Webhook 알림

두 번째 알림은 앞에서 만든 GitHub → Discord 직접 Webhook이었다. 형식이 고정되어 있고, 커스텀 알림과 역할이 겹치므로 저장소에서 삭제했다.

### 세 번째: 이번에 만든 커스텀 알림

세 번째 알림이 최종적으로 남길 알림이다.

![GitHub Actions로 생성한 Discord 댓글 알림](/images/blog/giscus-discord-github-actions-comment-notifications/discord-comment-notification.png)

_Giscus 댓글 이벤트를 GitHub Actions가 가공해 Discord Embed로 보낸 실제 결과._

## 최종 구조: GitHub Actions가 중간에서 메시지를 만든다

직접 Webhook 대신 GitHub Actions를 중간에 둔다.

~~~mermaid
sequenceDiagram
  participant V as 방문자
  participant G as Giscus
  participant D as GitHub Discussion
  participant A as GitHub Actions
  participant DC as Discord Webhook

  V->>G: 댓글 작성
  G->>D: Discussion comment 생성
  D-->>A: discussion_comment 이벤트
  A->>A: 제목에서 블로그 경로 계산
  A->>DC: 커스텀 JSON Embed 전송
  DC-->>A: 2xx 응답
~~~

핵심은 GitHub Actions가 블로그 서버에 요청하지 않는다는 점이다.

~~~text
블로그 Pod: 댓글을 직접 받지 않음
Kubernetes: 알림 처리에 관여하지 않음
GitHub Actions: 이벤트 수신, 메시지 가공, Discord 전송
Discord: 최종 알림 표시
~~~

GitHub는 Discussion 댓글 생성·수정·삭제에 대해 `discussion_comment` 이벤트를 제공한다. 이 이벤트 기반 Workflow는 파일이 기본 브랜치에 있어야 실행된다. [GitHub Actions 이벤트 문서](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

## 실제 Workflow 구성

전체 코드는 공개 저장소에서 확인할 수 있다.

[`.github/workflows/discord-comment.yml`](https://github.com/kimgunwooo/blog/blob/main/.github/workflows/discord-comment.yml)

핵심 트리거는 댓글이 생성될 때만 실행하도록 제한했다.

~~~yaml
name: Notify Discord about blog comments

on:
  discussion_comment:
    types: [created]

permissions: {}
~~~

수정·삭제 이벤트까지 알리려면 `types`에 `edited`, `deleted`를 추가할 수 있다. 현재는 새 댓글 알림만 필요하므로 `created`만 사용했다.

### Webhook URL은 Secret으로 관리한다

GitHub 저장소의 `Settings → Secrets and variables → Actions`에 다음 Secret을 등록했다.

~~~text
DISCORD_WEBHOOK_URL
~~~

여기에 넣는 값은 Discord 일반 Webhook URL이다.

~~~text
https://discord.com/api/webhooks/<id>/<token>
~~~

이번 방식에서는 URL 뒤에 `/github`를 붙이지 않는다. `/github`는 Discord가 GitHub payload를 직접 해석할 때 사용하는 전용 엔드포인트이고, Actions는 우리가 만든 일반 JSON을 보내기 때문이다.

Webhook URL은 메시지를 보낼 수 있는 인증 정보와 같다. 코드, 블로그 글, 로그에 기록하면 안 되고, 노출되었다면 Discord에서 Webhook을 폐기하고 새로 만들어야 한다.

### Discussion 제목에서 실제 블로그 URL을 만든다

현재 Giscus의 Discussion 제목은 다음 규칙을 따른다.

~~~text
blog/giscus-comments-operations-boundary/
~~~

Workflow에서는 `blog/` 뒤의 경로를 잘라 공개 블로그 주소에 붙인다.

~~~bash
if [[ "$TITLE" == blog/* ]]; then
  slug="${TITLE#blog/}"
  blog_url="${BLOG_ORIGIN%/}/blog/${slug#/}"
else
  blog_url="$DISCUSSION_URL"
fi
~~~

따라서 알림의 제목을 클릭하면:

~~~text
https://blog.kwl4b.com/blog/giscus-comments-operations-boundary/
~~~

로 이동한다. 제목이 `blog/` 규칙과 맞지 않는 Discussion이라면 안전하게 GitHub Discussion 링크로 대체한다.

### Discord Embed를 JSON으로 만든다

댓글 본문·작성자·링크를 `jq`로 JSON에 넣고 Discord 일반 Webhook에 전송한다.

~~~bash
payload="$(jq -n \
  --arg title "$TITLE" \
  --arg author "$AUTHOR" \
  --arg body "$BODY" \
  --arg blog_url "$blog_url" \
  --arg comment_url "$COMMENT_URL" \
  '{
    username: "blog-comments",
    allowed_mentions: {parse: []},
    embeds: [{
      title: ("💬 " + $title),
      url: $blog_url,
      description: $body,
      fields: [
        {name: "작성자", value: $author, inline: true},
        {name: "링크", value: ("[블로그 글 열기](" + $blog_url + ") · [댓글 보기](" + $comment_url + ")"), inline: true}
      ]
    }]
  }')"

curl --fail-with-body --silent --show-error \
  --request POST \
  --url "${DISCORD_WEBHOOK_URL}?wait=true" \
  --header "Content-Type: application/json" \
  --data "$payload"
~~~

`allowed_mentions: {parse: []}`도 의도적으로 넣었다. 댓글 본문에 `@everyone` 같은 문자열이 들어가도 알림을 보낸 사람을 대량 멘션하지 않도록 하기 위해서다.

## 댓글에서 Discord까지 얼마나 걸렸나

이번 테스트에서 댓글을 작성한 뒤 GitHub Actions의 `notify` 작업은 약 3초 만에 완료됐다. Discord에는 다음과 같은 커스텀 Embed가 도착했다.

~~~text
💬 blog/giscus-comments-operations-boundary/

Discord Actions 알림 테스트 — 2026-08-20

작성자        링크
kimgunwooo    블로그 글 열기 · 댓글 보기
~~~

다만 GitHub Actions는 즉시 실행되는 상시 프로세스가 아니다. 이벤트가 발생하면 GitHub가 Runner를 배정하고 Workflow를 시작한다. 따라서 실제 지연 시간은 다음 요소에 따라 달라진다.

- GitHub 이벤트 전달 시간
- Runner가 실행 대기열에서 기다린 시간
- Workflow 단계 실행 시간
- Discord API 응답 시간

평소에는 수 초에서 수십 초 수준으로 동작하겠지만, 정해진 실시간 처리 보장은 없다. 1초 이하의 즉시성이 필요하다면 직접 Webhook이나 Cloudflare Worker 같은 상시 중계 계층이 더 적합하다.

이 블로그의 댓글 알림에는 Actions 지연이 충분했다. 댓글이 달린 순간부터 몇 초 뒤에 Discord에서 확인할 수 있으면 운영 목적을 달성하기 때문이다. 별도 Pod나 데이터베이스를 추가하지 않고도 이 정도의 준실시간 알림을 얻을 수 있다는 점이 중요했다.

## 운영하면서 확인한 경계

### Ping 테스트는 댓글 테스트가 아니다

GitHub Webhook 화면의 `Test delivery`는 `ping` 이벤트를 보낸다. 실제 Discussion 댓글 생성 이벤트와 다르므로, Discord 메시지가 도착하는지 검증하려면 블로그에서 실제 댓글을 작성해야 한다.

### 직접 Webhook과 Actions Webhook을 동시에 두면 중복된다

직접 Webhook과 커스텀 Actions를 모두 켜 두면 댓글 하나에 기본 형식과 커스텀 형식이 함께 도착한다. 커스텀 알림이 정상 동작한 뒤 기존 직접 Webhook을 비활성화하거나 삭제해야 한다.

### Workflow 파일은 기본 브랜치에 있어야 한다

`discussion_comment` 이벤트는 Workflow 파일이 기본 브랜치에 존재할 때 실행된다. 로컬에만 파일을 만들어 두면 댓글이 달려도 Actions는 시작되지 않는다.

### 커밋 알림과 댓글 알림은 별개다

Discord의 GitHub 앱에서 Push 알림을 켜 두면 Workflow 파일을 수정하거나 블로그를 배포할 때 커밋 알림이 별도로 온다. 댓글 알림만 필요하다면 Push 구독을 끄는 편이 채널을 더 조용하게 유지한다.

## 결론: 댓글은 GitHub, 표현은 Actions, 전달은 Discord

이번 구성에서 각 시스템의 책임을 나누면 다음과 같다.

~~~text
Giscus             댓글 UI와 GitHub 로그인
GitHub Discussions 댓글 저장과 이벤트 발생
GitHub Actions     이벤트 필터링과 메시지 형식 변환
Discord Webhook    운영자에게 알림 표시
~~~

처음에는 GitHub Webhook만으로 충분하다고 생각했다. 실제로 댓글 알림은 빠르게 도착했다. 하지만 고정된 메시지 형식과 블로그 링크 부재가 아쉬웠고, GitHub Actions를 중간에 두면서 원하는 정보만 골라 Discord Embed로 만들 수 있었다.

정적 블로그에서 댓글 알림 하나를 위해 별도 API 서버나 Kubernetes Pod를 추가하는 것은 아직 과하다. 현재는 GitHub가 이미 가진 이벤트와 Actions Runner를 활용하는 구성이 가장 단순한 운영 경계라고 판단했다.

댓글 수가 크게 늘어나거나, 관리자 대시보드·알림 이력·중복 제거·재시도 정책이 필요해지는 시점에는 별도 알림 API를 검토할 수 있다. 지금 필요한 것은 댓글이 달렸다는 사실과 실제 글 링크를 놓치지 않는 것이고, 그 목적에는 이 구성이 충분했다.

## 참고 자료

- [Giscus 공식 저장소](https://github.com/giscus/giscus)
- [GitHub Actions: Discussion comment 이벤트](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Discord Webhook Resource](https://docs.discord.com/developers/resources/webhook)
- [Discord Server Integrations](https://support.discord.com/hc/en-us/articles/360045093012-Server-Integrations-Page)
- [블로그 저장소의 실제 Workflow 코드](https://github.com/kimgunwooo/blog/blob/main/.github/workflows/discord-comment.yml)
