---
title: 'FQS에서 대기열 인스턴스를 동적으로 만들기로 한 이유'
description: 'B2B 대기열 서비스에서 Kafka 중심 설계에서 Docker 기반 동적 인스턴스 구조로 방향을 바꾼 판단 과정을 정리했다.'
category: 'Automation'
pubDate: '2024-10-07'
createdAt: '2026-07-23T11:25:24+09:00'
updatedDate: '2026-07-23'
tags: ['fqs', 'queue', 'docker', 'eureka', 'gateway', 'sdk']
---

FQS는 B2B 개발자에게 대기열 기능을 제공하는 팀 프로젝트였다. 단순히 메시지를 큐에 넣고 빼는 서비스라기보다, 사용자가 자신의 서비스 앞단에 대기열을 붙일 수 있게 하는 것이 목적이었다.

여기서는 Kafka 중심 설계에서 Docker 기반 동적 인스턴스 구조로 방향을 바꿨던 판단 과정을 하나의 케이스 스터디로 정리한다.

## 문제

처음 요구사항은 아래처럼 잡았다.

| 요구 | 설명 |
| --- | --- |
| 대기열 생성 | 고객사가 이벤트나 서비스별 대기열을 생성한다. |
| 순서 제공 | 대기 중인 사용자의 순번을 제공한다. |
| 정책 옵션 | 중복 허용, 순서 보장, 최대 입장 수 같은 정책을 선택한다. |
| 단기 운영 | 이벤트성으로 쓰고 기간이 끝나면 중지할 수 있어야 한다. |
| 개발자 사용성 | 고객사 개발자가 SDK나 라이브러리로 쉽게 붙일 수 있어야 한다. |

은행 창구형 대기열과 티켓팅형 대기열은 요구가 달랐다.

은행 창구형은 운영 시간 동안 모든 사용자를 순서대로 처리하면 된다. 반면 티켓팅형은 한정 수량이 있고, 구매 페이지 진입 시점에 수량을 잡을지 결제 완료 시점에 잡을지에 따라 사용자 경험과 복구 로직이 달라진다.

그래서 FQS는 “하나의 고정 큐”보다 “대기열별 정책과 실행 환경을 만들 수 있는 구조”가 필요했다.

## 초기 설계: Kafka 중심 대기열

처음에는 Kafka를 중심에 두는 설계를 고민했다.

이유는 명확했다.

- 대량 요청을 순서 있게 다루기 좋다.
- 이벤트 로그를 남기기 좋다.
- 실패와 replay를 생각하기 쉽다.
- Kafka Streams, Kafka Connect 같은 확장 지점이 있다.

초기 아이디어는 대기열마다 topic을 두고, event sourcing처럼 대기열 진입/처리/종료 이벤트를 append하는 구조였다.

```text
queue event
  -> Kafka event topic
  -> stream processing
  -> queue별 read model
  -> client가 순번 조회
```

하지만 구현 중 두 가지 문제가 커졌다.

## 문제 1: 사용자별 producer/consumer 생명주기

대기열이 고객사나 이벤트 단위로 계속 생기면, topic과 producer/consumer 관리가 동적으로 변한다. 이 구조는 Spring Bean 생명주기와 충돌했다.

고정된 producer/consumer 조합을 미리 만들어두고 정책만 선택하게 하는 방식도 생각했지만, 대기열이 늘어나는 구조에서는 결국 운영 복잡도가 커졌다.

```text
대기열 생성
  -> topic 생성
  -> producer/consumer 연결
  -> read model 업데이트
  -> lifecycle 관리
```

학습 프로젝트에서 이 구조를 끝까지 가져가면 핵심 기능보다 Kafka 운영 문제에 더 많은 시간을 쓰게 될 가능성이 컸다.

## 문제 2: hot partition과 격리

특정 고객사의 대기열에만 트래픽이 몰리는 경우도 문제였다.

한 서버 안에서 여러 대기열을 모두 처리하면, 하나의 큰 고객사가 만든 부하가 다른 대기열에도 영향을 준다. 이 문제를 topic 설계만으로 해결하려면 partition, consumer group, topic 생성 정책, rebalance 비용까지 같이 관리해야 했다.

결국 질문이 바뀌었다.

```text
모든 대기열을 한 실행 환경 안에서 잘 나눌 것인가?
대기열별 실행 환경을 분리할 것인가?
```

FQS에서는 후자를 선택했다.

## 방향 전환: 대기열별 인스턴스 생성

최종 방향은 대기열 생성 요청이 들어오면, 대기열 서버와 Redis를 한 쌍으로 띄우는 구조였다.

```text
queue create request
  -> queue manager
  -> queue server container 생성
  -> Redis container 생성
  -> Eureka 등록
  -> Gateway route 반영
  -> client SDK로 호출
```

![FQS dynamic queue instance flow](/images/blog/fqs-dynamic-queue-instance-case-study/dynamic-queue-instance-flow.png)

Kafka를 완전히 버린 것은 아니었다. 대기열 상태의 백업, event store, replay 같은 용도로는 여전히 후보가 될 수 있었다. 다만 1차 구현의 중심 경로는 Redis와 동적 인스턴스 생성으로 단순화했다.

이 선택의 장점은 격리였다.

- 대기열별 JVM 옵션을 다르게 줄 수 있다.
- 대기열별 Redis를 따로 둘 수 있다.
- 특정 대기열 부하가 다른 대기열에 주는 영향을 줄일 수 있다.
- 생성/중지 lifecycle을 고객사 이벤트 기간과 맞출 수 있다.

## 선택지 비교

동적 실행 환경을 만드는 방법은 세 가지를 비교했다.

| 선택지 | 장점 | 포기한 이유 |
| --- | --- | --- |
| EC2 동적 생성 | 가장 강한 격리 | 생성 시간이 길고 설정/비용이 큼 |
| Kubernetes | Pod, Service, autoscaling, lifecycle 관리에 적합 | 당시 팀의 러닝커브와 일정상 부담이 큼 |
| Docker 직접 제어 | 빠르게 구현 가능, 기존 Spring Cloud 구조와 연결 쉬움 | host 자원 공유, Docker socket 권한 위험 |

운영적으로 이상적인 선택은 Kubernetes에 가까웠다. 하지만 당시에는 Spring Cloud Eureka와 Gateway 기반으로 이미 구조를 잡고 있었고, 2주 정도의 남은 기간 안에 Kubernetes 운영까지 새로 들고 가기 어려웠다.

그래서 1차 구현은 Docker 기반으로 결정했다.

## Docker Compose 대신 Docker CLI

대기열 서버와 Redis를 묶음으로 보면 Docker Compose가 자연스러웠다. 하지만 코드에서 매번 `docker-compose.yml`을 생성/수정/실행하는 방식은 관리가 애매했다.

1차 구현에서는 queue manager가 Docker 명령을 직접 실행하는 쪽으로 갔다.

```text
queue name
  -> container name prefix
  -> available port 할당
  -> queue server env 주입
  -> Redis env 주입
```

이 방식은 빠르지만 유지보수 관점에서는 약하다. container 이름 충돌, port 충돌, 실패한 container 정리, restart 정책을 모두 애플리케이션 코드가 알아야 하기 때문이다.

## DinD 대신 DooD

queue manager 자체도 container로 실행되기 때문에, container 안에서 다시 container를 띄워야 했다. 여기서 DinD와 DooD를 비교했다.

| 방식 | 설명 | 판단 |
| --- | --- | --- |
| DinD | container 안에 별도 Docker daemon 실행 | `--privileged`가 필요해 위험함 |
| DooD | host의 Docker socket을 container에 mount | host Docker를 직접 제어하므로 여전히 위험하지만 구현은 단순함 |

선택은 DooD였다.

```yaml
services:
  queue_manage:
    image: queue_manage:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

![DooD container create boundary](/images/blog/fqs-dynamic-queue-instance-case-study/dood-container-create-boundary.png)

이 선택은 운영적으로 좋은 답이라기보다, 제한된 기간 안에 동적 인스턴스 생성 흐름을 증명하기 위한 답이었다. Docker socket을 열어주는 것은 강한 권한을 넘기는 것이기 때문에, 실제 운영에서는 더 엄격한 격리와 권한 모델이 필요하다.

## Gateway와 SDK

대기열 서버가 새로 뜨면 외부 요청이 그 인스턴스로 들어가야 한다. 당시 구조는 Eureka와 Spring Cloud Gateway를 쓰고 있었기 때문에, 새 queue server가 Eureka에 등록되고 Gateway route가 갱신되는 흐름을 만들었다.

```text
queue server start
  -> Eureka register
  -> route data 저장
  -> Gateway refresh
  -> /queue/{queueId}/** 요청 라우팅
```

고객사 개발자가 직접 HTTP API를 모두 호출하게 하는 것보다, Java/Spring SDK를 제공하는 쪽도 같이 봤다. SDK는 Spring Boot AutoConfiguration을 사용해 dependency 추가만으로 필요한 bean이 등록되게 만드는 방향이었다.

배포는 Maven Central, Nexus, JitPack을 비교했고, 빠른 배포와 무료 사용을 위해 JitPack을 선택했다.

## 1차 구조의 한계

이 구조는 “동적으로 실행 환경을 만들 수 있다”는 것을 빠르게 증명했지만, 운영 기준으로는 한계가 명확했다.

| 한계 | 설명 |
| --- | --- |
| Docker socket 권한 | queue manager가 host Docker를 강하게 제어한다. |
| port 관리 | 사용 가능한 port 할당과 회수 정책이 필요하다. |
| container lifecycle | 실패, 재시작, 종료 후 정리 기준이 필요하다. |
| Gateway 반영 지연 | Eureka 등록과 route refresh 사이에 빈 구간이 생길 수 있다. |
| 관측 | queue별 metric, log, 비용, resource 사용량을 따로 봐야 한다. |

다시 만든다면 Kubernetes 기반으로 갈 가능성이 높다.

```text
queue create request
  -> Kubernetes Deployment/Service 생성
  -> Gateway 또는 Ingress route 생성
  -> HPA/resource quota 적용
  -> namespace 또는 label 기준 관측
```

이렇게 하면 lifecycle과 resource 제어를 애플리케이션 코드가 직접 들고 있지 않아도 된다.

## 정리

FQS에서 중요한 선택은 Kafka냐 Redis냐가 아니었다. 핵심은 대기열마다 부하와 lifecycle이 다르다는 점이었다.

그래서 최종적으로는 아래 기준을 남겼다.

1. 하나의 공유 실행 환경보다 대기열별 실행 환경 격리가 더 중요했다.
2. Kafka는 event store/replay 후보로 남기고, 1차 실행 경로는 Redis로 단순화했다.
3. Docker 기반 동적 생성은 빠르지만 권한과 lifecycle 관리 비용이 크다.
4. Gateway route와 service discovery까지 포함해야 “생성됐다”고 볼 수 있다.
5. SDK는 기능보다 고객사 개발자의 도입 비용을 줄이는 장치다.

원문:

- [B2B SaaS 대기열 제공 서비스 고민 flow](https://velog.io/@kimgunwooo/TIL-B2B-SaaS-%EB%8C%80%EA%B8%B0%EC%97%B4-%EC%A0%9C%EA%B3%B5-%EC%84%9C%EB%B9%84%EC%8A%A4-%EA%B3%A0%EB%AF%BC-flow)
- [동적 인스턴스 생성](https://velog.io/@kimgunwooo/TIL-%EB%8F%99%EC%A0%81-%EC%9D%B8%EC%8A%A4%ED%84%B4%EC%83%9D%EC%84%B1-Docker%EB%A5%BC-%EA%B3%81%EB%93%A4%EC%9D%B8)
- [라이브러리 만들기](https://velog.io/@kimgunwooo/FQS-%EB%9D%BC%EC%9D%B4%EB%B8%8C%EB%9F%AC%EB%A6%AC-%EB%A7%8C%EB%93%A4%EA%B8%B0)
