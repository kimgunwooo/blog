---
title: 'Argo CD 배포 결과를 Discord로 받기: Secret 하나로는 알림이 오지 않는 이유'
description: 'Kubernetes GitOps 배포가 끝났는지 사람이 직접 확인하지 않도록, Argo CD Notifications와 Discord webhook을 연결한 과정을 정리했다.'
category: 'Kubernetes'
pubDate: '2026-08-19'
tags: ['argocd', 'discord', 'gitops', 'kubernetes', 'notifications', 'webhook']
---

배포가 끝날 때마다 Argo CD 화면을 열어 상태를 확인하는 일이 조금씩 귀찮아졌다. 배포가 성공했는지, 새 Pod가 실제로 준비됐는지, 혹시 Sync가 실패했는지를 Discord에서 바로 받고 싶었다.

처음에는 Discord webhook URL을 Kubernetes Secret으로 만들면 충분할 것이라고 생각했다. 하지만 Secret만 만든다고 알림이 오지는 않았다.

Secret은 **어디로 보낼지**만 알고 있다. Argo CD Notifications가 실제로 메시지를 보내려면 다음 세 가지가 모두 필요하다.

1. Discord webhook URL을 담은 Secret
2. 어떤 조건에 어떤 메시지를 보낼지 정의한 ConfigMap
3. 어떤 Argo CD Application이 그 알림을 구독할지 연결하는 annotation

이번 글에서는 개인 Kubernetes 환경에 배포한 블로그 애플리케이션을 기준으로 이 구조를 적용한 과정을 정리한다.

## 배포 완료를 사람이 확인하던 흐름

기존 배포 흐름은 대략 다음과 같았다.

```mermaid
sequenceDiagram
  participant D as Developer
  participant CI as CI/CD
  participant G as Git repository
  participant A as Argo CD
  participant K as Kubernetes
  participant H as Human

  D->>CI: source push
  CI->>CI: image build and push
  CI->>G: manifest image update
  G->>A: desired state change
  A->>K: sync resources
  H->>A: manually check sync and health
```

배포 자체는 자동화되어 있었지만 마지막 확인은 수동이었다. 자동화의 마지막 단계에 사람이 남아 있는 셈이었다.

목표는 다음과 같이 바꾸는 것이었다.

```mermaid
flowchart LR
  A["Argo CD Application"] --> B["Notifications Controller"]
  B --> C["Success / failure trigger"]
  C --> D["Discord webhook"]
  B --> E["Kubernetes Secret"]
```

여기서 중요한 점은 Notifications Controller가 Secret만 읽는 것이 아니라, Application 상태와 ConfigMap의 trigger·template도 함께 읽는다는 것이다.

## Secret은 목적지 주소일 뿐이다

먼저 `argocd` namespace에 다음 Secret을 만들었다.

```text
argocd-notifications-secret
└── discord-webhook-url
```

실제 URL은 예제에 적지 않는다. webhook URL은 외부에서 메시지를 보낼 수 있는 인증 정보와 같은 성격이므로 Git 저장소, 블로그 글, 일반 로그에 남기면 안 된다.

Secret이 담당하는 책임은 하나다.

```text
discord-webhook-url = Discord로 요청을 보낼 주소
```

반대로 Secret에는 다음 정보가 없다.

- 언제 보내야 하는가
- 성공과 실패를 어떻게 구분하는가
- Discord 메시지의 제목과 내용은 무엇인가
- 어떤 Argo CD Application이 대상인가

그래서 Secret을 만든 직후에도 아무 알림이 오지 않는 것이 정상이다.

## ConfigMap에 서비스, 메시지, 조건을 정의한다

Argo CD Notifications의 ConfigMap에는 세 종류의 설정이 들어간다.

| 구성 | 책임 |
| --- | --- |
| Service | Discord webhook으로 요청을 보내는 방법 |
| Template | Discord에 보낼 메시지 형식 |
| Trigger | 어떤 Application 상태에서 Template을 실행할지 |

### Discord 서비스

실제 URL을 ConfigMap에 직접 적지 않고 Secret 참조를 사용한다.

```yaml
service.webhook.discord: |
  url: $discord-webhook-url
  headers:
    - name: Content-Type
      value: application/json
```

`$discord-webhook-url`은 literal URL이 아니다. Notifications Controller가 `argocd-notifications-secret`에서 같은 이름의 키를 찾아 실제 URL로 치환한다.

### 성공 메시지 Template

성공 Template에는 Discord Embed를 사용했다. 애플리케이션 이름, Git revision, Sync 상태, Health 상태를 함께 보내도록 했다.

```yaml
template.discord-deployed: |
  webhook:
    discord:
      method: POST
      body: |
        {
          "username": "Argo CD",
          "embeds": [{
            "title": "배포 완료: {{.app.metadata.name}}",
            "color": 5763719,
            "fields": [
              {"name": "Revision", "value": "{{.app.status.sync.revision}}", "inline": true},
              {"name": "Status", "value": "{{.app.status.sync.status}} / {{.app.status.health.status}}", "inline": true}
            ]
          }]
        }
```

`{{.app...}}`는 Notifications Controller가 현재 Argo CD Application 객체의 값으로 치환하는 템플릿 표현식이다.

실패 Template은 제목과 색상을 다르게 하고, Sync 실패의 phase를 표시하도록 만들었다.

### 성공과 실패 Trigger

이번에는 배포 성공을 다음 두 조건이 모두 맞을 때로 정의했다.

```yaml
trigger.on-deployed-discord: |
  - description: Application is synced and healthy
    oncePer: app.status.sync.revision
    send: [discord-deployed]
    when: app.status.operationState.phase in ['Succeeded'] && app.status.health.status == 'Healthy'
```

Sync 작업만 성공했다고 바로 “배포 완료”라고 판단하지 않은 이유가 있다. Manifest 적용은 끝났지만 새 Deployment가 아직 rollout 중이거나, readiness probe에 실패해 Health가 나쁠 수 있다.

따라서 이번 글에서의 배포 완료는 다음의 교집합이다.

```text
Argo Sync 성공
∩
Application Health Healthy
```

`oncePer`는 같은 Git revision에 대해 성공 알림이 계속 반복되지 않게 한다.

실패 조건은 Sync operation 자체가 `Error` 또는 `Failed`가 된 경우로 제한했다.

```yaml
trigger.on-sync-failed-discord: |
  - description: Application sync failed
    send: [discord-sync-failed]
    when: app.status.operationState.phase in ['Error', 'Failed']
```

여기에는 운영상 중요한 범위가 있다. 현재 설정은 **Argo Sync 실패**를 알린다. Sync는 성공했지만 이후 애플리케이션이 `Degraded`가 되는 모든 상황까지 알리는 설정은 아니다. 그런 상태까지 감시하려면 Health 변화용 trigger를 별도로 추가해야 한다.

## Application에 알림 구독을 연결한다

Service와 Template과 Trigger를 만들어도 대상 Application이 구독하지 않으면 메시지가 가지 않는다.

그래서 배포 대상 Application에 다음 annotation을 붙였다.

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-deployed-discord.discord: ''
    notifications.argoproj.io/subscribe.on-sync-failed-discord.discord: ''
```

이 annotation은 다음 문장과 같다.

```text
이 Application이 on-deployed-discord trigger를 discord 서비스로 구독한다.
이 Application이 on-sync-failed-discord trigger를 discord 서비스로 구독한다.
```

값이 비어 있는 것처럼 보이는 이유는 webhook URL을 annotation에 넣지 않기 때문이다. URL은 Service가 Secret에서 가져간다.

구성 요소를 책임별로 나누면 다음과 같다.

```mermaid
flowchart TB
  S["Secret\nwebhook URL"] --> W["Webhook Service\n어디로 보낼지"]
  T["Template\n무슨 내용을 보낼지"] --> N["Notifications Controller"]
  R["Trigger\n언제 보낼지"] --> N
  W --> N
  N --> D["Discord"]
  A["Application annotation\n누가 받을지"] --> N
```

이 분리가 이번 작업에서 가장 중요했다.

```text
Secret      = 어디로
Template    = 무엇을
Trigger     = 언제
Annotation  = 누구에게 적용할지
Controller  = 실제 실행
```

## 실제 적용 후 확인한 것

설정을 적용한 뒤 다음 항목을 확인했다.

### 1. ConfigMap 키가 로드됐는가

다음 다섯 가지 설정이 존재하는지 확인했다.

```text
service.webhook.discord
template.discord-deployed
template.discord-sync-failed
trigger.on-deployed-discord
trigger.on-sync-failed-discord
```

### 2. Application이 구독했는가

배포 대상 Application annotation에 성공·실패 구독이 모두 존재하는지 확인했다.

### 3. Controller가 실행 중인가

Notifications Controller Pod가 `1/1 Running`인지 확인했다.

### 4. 성공 알림이 실제 발화했는가

컨트롤러 로그에서 다음 흐름을 확인했다.

```text
on-deployed-discord TRIGGERED
Sending notification
Discord webhook POST
```

실패 상태를 일부러 만들지는 않았다. 운영 중인 서비스의 배포를 고의로 깨뜨리는 대신, 성공 경로는 실제 상태로 확인하고 실패 경로는 trigger 조건과 Template 로딩을 검증하는 방식으로 남겼다.

## 로그에 webhook URL을 남기지 않기

검증 과정에서 webhook HTTP 요청을 디버그 로그로 출력하는 동작을 확인했다. URL은 단순한 식별자가 아니라 Discord에 요청을 보낼 수 있는 민감 정보다.

그래서 Notifications Controller의 로그 레벨을 `warn`으로 낮추고 재시작했다. 그리고 webhook URL이 노출됐을 가능성이 있으면 기존 Discord webhook을 폐기하고 새로 발급하는 것이 안전하다.

새 webhook을 발급한 뒤에는 ConfigMap을 다시 수정할 필요가 없다. Secret의 값만 교체하면 된다.

```bash
export DISCORD_WEBHOOK_URL='새_webhook_URL'

kubectl -n argocd create secret generic argocd-notifications-secret \
  --from-literal=discord-webhook-url="$DISCORD_WEBHOOK_URL" \
  --dry-run=client -o yaml | kubectl apply -f -
```

이 명령을 실행할 때 URL을 터미널 기록이나 채팅에 직접 남기지 않는 것이 좋다.

## 정리

이번 작업을 하면서 알림 설정을 다음처럼 이해하게 됐다.

> Secret 하나는 알림 시스템이 아니라 목적지 주소다.

Argo CD에서 Discord 알림을 구성하려면 다음 책임을 연결해야 한다.

1. Secret에 Discord webhook URL을 저장한다.
2. ConfigMap에 Discord Service를 정의한다.
3. 성공·실패 메시지 Template을 만든다.
4. Application 상태를 판단할 Trigger를 만든다.
5. Application annotation으로 알림 구독을 연결한다.
6. Notifications Controller가 설정을 읽고 webhook 요청을 실행하는지 확인한다.

이 구조의 장점은 알림 목적지, 메시지 형식, 상태 조건, 대상 Application을 각각 바꿀 수 있다는 데 있다. Discord 대신 다른 webhook을 사용하거나, 실패 알림만 추가하거나, 여러 Application을 같은 trigger에 연결할 때도 책임 경계가 섞이지 않는다.

다음 단계로는 `Degraded`, rollout timeout, sync 상태 변화처럼 “Sync는 성공했지만 서비스가 정상적이지 않은 경우”를 별도 알림 조건으로 추가할 수 있다. 다만 알림 조건을 늘릴수록 운영 채널이 시끄러워질 수 있으므로, 어떤 상태를 실제 대응 대상으로 볼지 먼저 정하는 편이 좋다.

## 참고 자료

- [Argo CD Notifications: Services overview](https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/services/overview/)
- [Argo CD Notifications: Webhook service](https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/services/webhook/)
- [Argo CD Notifications: Subscriptions](https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/subscriptions/)
- [Argo CD Notifications: Triggers](https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/triggers/)
- [Discord: Webhooks](https://docs.discord.com/developers/platform/webhooks)
