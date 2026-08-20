---
title: 'Gateway와 Auth Server 사이에서 인증 책임을 어디까지 나눌까'
description: 'MSA에서 JWT 검증을 Gateway에서 끝낼지, Auth Server와 User Server까지 나눌지 고민한 기준을 정리했다.'
category: 'Network'
pubDate: '2024-09-09'
createdAt: '2026-07-23T11:25:24+09:00'
updatedDate: '2026-07-23'
tags: ['msa', 'gateway', 'auth-server', 'jwt', 'redis', 'spring-security']
---

MSA에서 인증/인가는 어디에 두어야 할까. 처음에는 Gateway에서 JWT만 검증하면 충분하다고 생각했다. 클라이언트 요청이 가장 먼저 도착하는 지점이 Gateway이고, 인증되지 않은 요청을 뒤쪽 서비스까지 보내지 않는 것이 자연스럽기 때문이다.

하지만 Gateway에서 모든 인증/인가 판단을 끝낼 수 있는지는 다른 문제다. 사용자 상태, 권한 최신성, 관리자 권한, 탈퇴/차단 사용자 반영까지 생각하면 Auth Server와 User Server의 책임을 나누는 기준이 필요했다.

이 글은 JWT Gateway filter를 구현하면서 Gateway, Auth Server, User Server 사이의 인증 책임을 어디까지 나눌지 정리한 기록이다.

## 처음 생각

초기 판단은 단순했다.

```text
client
  -> gateway
  -> backend services
```

Gateway에서 JWT를 검증하고, 문제가 없으면 뒤쪽 서비스로 route한다. 이 구조는 장점이 분명하다.

- 인증되지 않은 요청을 앞단에서 차단할 수 있다.
- 각 서비스가 JWT 검증 코드를 반복하지 않아도 된다.
- 단순 권한은 token claim으로 판단할 수 있다.
- Gateway filter에서 공통 로그와 차단 기준을 남기기 쉽다.

Spring Cloud Gateway에서는 `GlobalFilter`로 모든 요청을 검사할 수 있다. 예외 경로는 로그인 API 정도다.

```java
if (path.equals("/auth/signIn")) {
    return chain.filter(exchange);
}

String token = extractToken(exchange);

if (token == null || !validateToken(token)) {
    exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
    return exchange.getResponse().setComplete();
}

return chain.filter(exchange);
```

이 정도 구조만 있어도 `/auth/signIn`은 통과시키고, 나머지 요청은 token 검증 후 route할 수 있다.

## Gateway가 잘하는 일

Gateway는 공통 차단에 적합하다.

| Gateway 책임 | 이유 |
| --- | --- |
| token 존재 여부 확인 | 인증 없는 요청을 뒤쪽 서비스로 보내지 않음 |
| token 서명/만료 검증 | stateless하게 빠르게 판단 가능 |
| 공통 blacklist 확인 | 탈퇴/차단 token을 앞단에서 차단 |
| route별 기본 권한 확인 | `USER`, `ADMIN` 같은 단순 claim 확인 |
| 사용자 정보 header 전달 | 뒤쪽 서비스가 공통 사용자 식별자를 읽게 함 |

JWT 기반이면 Gateway가 매 요청마다 Auth Server에 물어보지 않아도 된다. token 자체에 서명과 만료 시간이 있고, claim을 통해 기본 권한을 확인할 수 있기 때문이다.

하지만 이 방식은 token 안의 정보가 최신이라는 전제를 둔다. 사용자의 권한이 방금 바뀌었거나, 탈퇴/차단이 즉시 반영되어야 한다면 token만으로는 부족하다.

## Auth Server가 필요한 지점

Auth Server를 따로 두는 이유는 단순히 “MSA니까 인증 서버도 분리한다”가 아니었다.

![Auth server boundary](/images/blog/gateway-auth-server-responsibility-boundary/auth-server-boundary.png)

Auth Server가 있으면 아래 책임을 분리할 수 있다.

| Auth Server 책임 | 설명 |
| --- | --- |
| 로그인/토큰 발급 | 인증 정보를 검증하고 access token을 발급 |
| token parsing/validation 정책 | 여러 Gateway가 같은 검증 정책을 쓰게 함 |
| refresh/reissue 흐름 | access token 재발급 기준을 중앙화 |
| 민감 권한 재검증 | 관리자 권한처럼 최신 상태가 필요한 요청을 다시 확인 |
| scale-out | Gateway, User Server와 별도로 인증 부하를 확장 |

특히 Gateway가 여러 개로 늘거나, User Server가 여러 도메인으로 나뉘면 Auth Server의 존재 이유가 더 커진다. 인증/인가 정책이 Gateway마다 흩어지면 같은 token인데 어떤 Gateway에서는 통과되고, 다른 Gateway에서는 차단되는 문제가 생길 수 있다.

## User Server와의 경계

Auth Server가 생긴다고 해서 사용자 데이터의 원천까지 모두 가져갈 필요는 없다. 사용자 상태와 권한의 원천 데이터는 User Server가 갖고, Auth Server는 인증 흐름과 token 발급 책임을 갖는 식으로 나눌 수 있다.

```text
login request
  -> gateway
  -> auth-server
  -> user-server: 계정/권한 확인
  -> auth-server: token 발급
```

이 구조에서 User Server는 사용자 데이터의 원천이다.

- 계정 존재 여부
- 비밀번호 검증에 필요한 정보
- 권한 목록
- 탈퇴/차단 상태
- 관리자 권한 변경 이력

Auth Server는 이 정보를 바탕으로 token을 발급하거나, 필요한 경우 최신 권한을 다시 확인한다. Gateway는 그 결과를 기준으로 요청을 통과시키거나 차단한다.

## Redis blacklist

JWT는 stateless해서 빠르지만, 발급된 token을 서버가 즉시 회수하기 어렵다. 사용자가 탈퇴하거나 차단됐는데 token 만료 시간이 남아 있다면 문제가 된다.

그래서 Redis blacklist를 둘 수 있다.

```text
logout / withdraw / ban
  -> token id 또는 user id를 Redis blacklist에 저장
  -> Gateway filter에서 blacklist 확인
  -> 있으면 401 또는 403 반환
```

여기서도 기준이 필요하다.

| 기준 | 설명 |
| --- | --- |
| 저장 key | token jti, user id, refresh token id 중 무엇을 막을지 |
| TTL | token 만료 시간과 맞춰 blacklist TTL 설정 |
| 장애 처리 | Redis 장애 시 fail-open인지 fail-closed인지 결정 |
| 범위 | 모든 요청에서 볼지, 민감 route에서만 볼지 결정 |

Redis blacklist는 JWT의 stateless 장점을 일부 포기하는 선택이다. 하지만 탈퇴/차단 반영처럼 즉시성이 필요한 요구가 있다면 현실적인 절충안이 된다.

## 민감 권한은 한 번 더 본다

기본 사용자 요청은 token claim만으로 충분할 수 있다. 하지만 관리자 기능처럼 권한 변경이 민감한 요청은 다르게 봐야 한다.

```text
normal request
  -> Gateway JWT 검증
  -> route

admin request
  -> Gateway JWT 검증
  -> Auth/User Server에 최신 권한 확인
  -> route
```

권한이 자주 바뀌지 않는다면 매 요청마다 DB를 보는 것은 과하다. 반대로 관리자 기능에서 token 만료 시간 동안 이전 권한이 유지되는 것도 위험하다. 그래서 route별로 검증 강도를 다르게 두는 방식이 더 현실적이다.

## 직접 접근 차단

Gateway에서 인증을 처리한다면, 뒤쪽 서비스가 외부에서 직접 호출되지 않게 막아야 한다.

실습에서는 product-service를 직접 호출하면 인증 처리 없이 응답이 돌아왔다. 이건 Gateway filter가 틀린 것이 아니라, network boundary가 닫히지 않았기 때문에 생긴 문제다.

운영 구조에서는 아래 기준이 필요하다.

```text
external
  -> gateway만 접근 허용

internal service
  -> private network에서만 접근
```

AWS라면 security group, private subnet, load balancer 노출 범위로 막을 수 있고, Kubernetes라면 Ingress, Service type, NetworkPolicy로 경계를 잡을 수 있다.

Gateway 인증은 network 차단과 같이 가야 한다. 뒤쪽 서비스가 외부에 열려 있으면 Gateway에서 아무리 잘 막아도 우회 경로가 남는다.

## 정리

이 고민에서 남은 기준은 아래다.

1. Gateway는 공통 token 검증과 빠른 차단에 적합하다.
2. Auth Server는 로그인, token 발급, 검증 정책, 민감 권한 재확인 책임을 갖는다.
3. User Server는 사용자 상태와 권한 원천 데이터를 가진다.
4. JWT만 쓰면 빠르지만 탈퇴/차단 즉시 반영에는 Redis blacklist 같은 보완이 필요하다.
5. 관리자 요청처럼 민감한 route는 token claim만 믿지 않고 최신 권한을 다시 확인할 수 있다.
6. Gateway 인증을 쓰려면 뒤쪽 서비스의 직접 접근 경로도 막아야 한다.

중요한 것은 Auth Server가 있느냐 없느냐가 아니다. 어떤 판단을 Gateway에서 끝내고, 어떤 판단은 Auth/User Server까지 가야 하는지 기준을 남기는 것이다.

원문:

- [MSA에서 인증/인가 처리](https://velog.io/@kimgunwooo/TIL-MSA-%EC%97%90%EC%84%9C-%EC%9D%B8%EC%A6%9D%EC%9D%B8%EA%B0%80-%EC%B2%98%EB%A6%AC)
- [보안 구성](https://velog.io/@kimgunwooo/TIL-%EB%B3%B4%EC%95%88-%EA%B5%AC%EC%84%B1)
