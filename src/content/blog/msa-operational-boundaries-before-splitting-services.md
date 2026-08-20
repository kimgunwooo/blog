---
title: 'MSA를 나누기 전에 먼저 봐야 할 운영 경계'
description: '서비스를 나누면 설정, 라우팅, 인증, 발견, 트랜잭션 경계가 같이 늘어난다는 점을 Spring Cloud 기준으로 정리했다.'
category: 'Network'
pubDate: '2024-08-05'
createdAt: '2026-07-23T11:25:24+09:00'
updatedDate: '2026-07-23'
tags: ['msa', 'spring-cloud', 'eureka', 'gateway', 'config', 'auth']
---

MSA를 처음 공부할 때는 서비스를 작게 나누는 구조 자체가 좋아 보였다. 독립 배포, 서비스별 확장, 작은 팀 단위 개발 같은 장점이 분명하기 때문이다.

하지만 서비스를 나누면 코드만 나뉘는 것이 아니다. 라우팅, 설정, 인증, 서비스 발견, 장애 추적, 트랜잭션 경계도 같이 생긴다. 그래서 MSA를 도입할 때 먼저 봐야 하는 것은 “몇 개의 서비스로 나눌까”보다 “나눈 뒤 누가 어떤 운영 책임을 갖는가”에 가깝다.

이 글은 MSA, Spring Cloud, Eureka, Config, Gateway, 인증/인가를 따로 보지 않고 운영 경계 관점에서 다시 묶어 정리한 기록이다.

## 먼저 볼 기준

모놀리식과 MSA의 차이는 단순히 배포 단위의 차이로 끝나지 않는다.

| 기준 | 모놀리식 | MSA |
| --- | --- | --- |
| 배포 | 하나의 애플리케이션을 한 번에 배포 | 서비스별로 독립 배포 |
| 호출 | 대부분 프로세스 내부 호출 | 네트워크 호출 증가 |
| 설정 | 한 애플리케이션 기준으로 관리 | 서비스별 설정과 환경 관리 필요 |
| 데이터 | 단일 DB에서 일관성 관리가 쉬움 | 서비스별 데이터 경계와 정합성 문제가 생김 |
| 장애 분석 | 한 프로세스 안에서 추적 가능 | 요청 경로와 로그를 이어 봐야 함 |

서비스를 나누는 이유가 명확하지 않다면 MSA는 문제를 줄이기보다 운영 지점을 늘릴 수 있다. 빠르게 프로토타입을 만들어야 하거나 팀 규모가 작다면, 모놀리식으로 시작한 뒤 병목이 되는 경계부터 나누는 편이 더 현실적일 수 있다.

## Spring Cloud가 맡는 경계

Spring Cloud는 MSA에서 반복되는 운영 문제를 애플리케이션 레벨에서 풀기 위한 도구 묶음에 가깝다.

### Gateway

Gateway는 클라이언트 요청이 처음 들어오는 진입점이다.

```text
client
  -> gateway
  -> order-service
  -> product-service
```

여기서 결정해야 할 것은 라우팅만이 아니다.

- 어떤 URL을 어떤 서비스로 보낼지
- 공통 인증을 어디까지 처리할지
- 요청/응답 로그를 어디서 남길지
- 장애가 난 서비스로 요청을 계속 보낼지
- Gateway 자체를 어떻게 scale-out 할지

Gateway가 편한 이유는 요청의 앞단을 한 곳에서 다룰 수 있기 때문이다. 반대로 말하면 Gateway가 무거워질수록 단일 장애 지점이 되기 쉽다. 그래서 Gateway는 상태를 덜 가지게 만들고, route/filter/auth 같은 공통 책임의 범위를 명확히 잡아야 한다.

### Eureka

서비스가 여러 인스턴스로 늘어나면 호출하는 쪽이 대상 서버의 host와 port를 직접 알기 어렵다. Eureka는 서비스 인스턴스가 자신을 등록하고, 호출하는 쪽이 필요한 서비스를 이름으로 찾게 해준다.

```text
product-service instance
  -> register
  -> eureka

order-service
  -> lookup product-service
  -> call available instance
```

이 경계가 생기면 운영 질문도 달라진다.

- 인스턴스가 내려갔을 때 registry에서 언제 빠지는가
- health check 기준은 무엇인가
- 새 인스턴스가 뜬 뒤 언제 트래픽을 받을 수 있는가
- 로컬, 테스트, 운영 환경의 discovery 주소는 어떻게 분리하는가

단순히 Eureka UI에 인스턴스가 보이는지보다, 장애 인스턴스가 호출 경로에서 제외되는 시간을 보는 것이 더 운영에 가깝다.

### Config

서비스가 늘어나면 설정 파일도 늘어난다. 포트, endpoint, feature flag, 외부 API 주소, profile별 값이 서비스마다 흩어지면 배포보다 설정 변경이 더 위험해질 수 있다.

Spring Cloud Config는 설정을 중앙에서 관리하고, 서비스가 시작할 때 또는 refresh 시점에 설정을 가져오게 한다.

```text
config repository
  -> config-server
  -> product-service / order-service / gateway
```

Config를 쓰면 설정의 위치는 정리된다. 하지만 운영 기준은 별도로 정해야 한다.

- 설정 변경은 pull request로 관리할 것인가
- 운영 설정 변경 후 어떤 서비스에 refresh를 호출할 것인가
- 모든 설정을 동적으로 바꿀 수 있게 둘 것인가
- Secret은 Config와 같은 경로로 둘 것인가
- 잘못된 설정이 배포되었을 때 rollback은 어떻게 할 것인가

설정을 중앙화하면 편해지지만, 잘못 바뀐 설정도 중앙에서 빠르게 퍼질 수 있다.

### Auth

MSA에서 인증/인가를 어디서 처리할지도 초기에 정해야 하는 경계다.

초기에는 Gateway에서 JWT를 검증하고, 기본 권한은 토큰 기준으로 판단할 수 있다. 인증되지 않은 요청을 실제 서비스까지 보내지 않아도 되기 때문이다. 다만 권한이 자주 바뀌거나, 여러 서비스가 사용자 상태를 정밀하게 판단해야 한다면 Auth Server를 따로 두는 선택지도 생긴다.

```text
client
  -> gateway
  -> auth-server
  -> user-service
```

여기서 중요한 질문은 “Auth Server를 만들까”보다 “인증 판단을 누가 책임지는가”다.

- Gateway는 토큰 서명만 검증하는가
- 최신 권한은 Auth/User 서버에 다시 묻는가
- 탈퇴/차단 사용자는 Redis blacklist로 막는가
- 각 서비스는 사용자 정보를 header로 신뢰해도 되는가
- 관리자 권한처럼 민감한 요청은 2차 검증이 필요한가

인증 로직이 Gateway, Auth Server, User Service에 흩어지면 장애보다 더 무서운 것이 정책 불일치다. 그래서 처음부터 완벽히 나누기보다, 책임 경계를 문서로 남기는 것이 먼저다.

## Kubernetes와 Spring Cloud

Kubernetes와 Spring Cloud는 겹쳐 보이지만 초점이 다르다.

| 구분 | Spring Cloud | Kubernetes |
| --- | --- | --- |
| 초점 | 애플리케이션 간 통신, discovery, config, gateway | container 배포, 스케일링, 복구, service network |
| 주요 단위 | service application | pod, deployment, service, ingress |
| 설정 | Config Server, profile | ConfigMap, Secret |
| discovery | Eureka, Consul 등 | Kubernetes Service, DNS |

둘 중 하나만 정답인 구조는 아니다. Kubernetes 위에서 Spring Cloud 일부 기능을 같이 쓸 수도 있다. 다만 둘 다 도입하면 장애를 볼 위치가 늘어난다.

예를 들어 호출이 실패했을 때 아래를 같이 봐야 한다.

- Gateway route가 맞는가
- Eureka registry에 인스턴스가 남아 있는가
- Kubernetes Service endpoint가 살아 있는가
- Pod readiness가 통과되었는가
- Config가 운영 profile로 들어갔는가

도구를 많이 붙이는 것보다, 장애가 났을 때 어디서부터 확인할지 순서를 정하는 것이 더 중요하다.

## 트랜잭션 경계

MSA에서 제일 크게 걸리는 부분은 데이터 정합성이다.

예를 들어 주문 서비스가 상품 서비스의 재고를 줄이고, 그 다음 주문 정보를 저장한다고 가정한다.

```text
order-service
  -> product-service: decrease stock
  -> order database: save order
```

재고 차감은 성공했는데 주문 저장이 실패하면 어떻게 되돌릴지 정해야 한다. 모놀리식에서는 하나의 DB transaction으로 묶기 쉬웠던 문제가, 서비스가 나뉘는 순간 분산 트랜잭션 문제가 된다.

대표적인 선택지는 2PC와 SAGA다.

| 방식 | 특징 | 운영 부담 |
| --- | --- | --- |
| 2PC | 여러 참여자가 준비 단계와 commit/rollback 단계를 거침 | 일관성은 강하지만 blocking과 단일 실패 지점 부담이 큼 |
| SAGA | 여러 로컬 트랜잭션과 보상 트랜잭션으로 나눔 | retry, idempotency, 보상 실패 처리, 추적 기준이 필요 |

SAGA를 쓰면 “실패하면 보상하면 된다”로 끝나지 않는다. 보상 트랜잭션이 실패했을 때, 이벤트가 중복 처리되었을 때, 메시지 큐에 쌓인 이벤트가 늦게 처리될 때를 같이 봐야 한다. 그래서 분산 트랜잭션은 설계 패턴보다 운영 기준이 더 중요하다.

## 나누기 전 점검표

MSA로 나누기 전에 최소한 아래 질문에는 답이 있어야 한다.

1. 서비스별 route의 소유자는 누구인가
2. 서비스 주소는 어디서 발견하고, 장애 인스턴스는 언제 제외되는가
3. 설정 변경은 어디서 관리하고, 운영 반영은 어떤 절차로 하는가
4. 인증 판단은 Gateway, Auth Server, 각 서비스 중 어디까지 나눌 것인가
5. 서비스 간 호출 실패 시 retry, timeout, fallback 기준은 무엇인가
6. 여러 서비스에 걸친 트랜잭션은 2PC, SAGA, 수동 보정 중 무엇으로 처리할 것인가
7. 장애가 났을 때 trace, metric, log를 어떤 순서로 볼 것인가

MSA는 서비스를 작게 나누는 기술이라기보다, 나뉜 책임을 운영 가능한 단위로 다시 묶는 일에 가깝다. 이 경계가 정리되지 않으면 독립 배포의 장점보다 장애 분석과 정책 불일치 비용이 먼저 커진다.

원문:

- [MSA 환경에서 생각해봐야 할 것들](https://velog.io/@kimgunwooo/TIL-MSA-%ED%99%98%EA%B2%BD%EC%97%90%EC%84%9C-%EC%83%9D%EA%B0%81%ED%95%B4%EB%B4%90%EC%95%BC-%ED%95%A0-%EA%B2%83%EB%93%A4)
- [MSA](https://velog.io/@kimgunwooo/TIL-MSA)
- [Spring Cloud Eureka](https://velog.io/@kimgunwooo/TIL-Spring-Cloud-Eureka)
- [Spring Cloud Config](https://velog.io/@kimgunwooo/TIL-Spring-Cloud-Config)
- [API 게이트웨이, Spring Cloud Gateway](https://velog.io/@kimgunwooo/TIL-API-%EA%B2%8C%EC%9D%B4%ED%8A%B8%EC%9B%A8%EC%9D%B4-Spring-Cloud-Gateway)
- [MSA에서 인증/인가 처리](https://velog.io/@kimgunwooo/TIL-MSA-%EC%97%90%EC%84%9C-%EC%9D%B8%EC%A6%9D%EC%9D%B8%EA%B0%80-%EC%B2%98%EB%A6%AC)
