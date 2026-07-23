---
title: 'Spring Cloud Gateway RateLimiter는 Redis에서 무엇을 기록할까'
description: 'Spring Cloud Gateway의 RequestRateLimiter가 key, token bucket, Redis Lua script로 요청을 제한하는 흐름을 정리했다.'
category: 'Network'
pubDate: '2025-04-04'
updatedDate: '2026-07-23'
tags: ['spring-cloud-gateway', 'redis', 'rate-limiter', 'token-bucket']
---

Rate limiting은 단순히 트래픽을 막는 기능이 아니다. 어떤 기준으로 사용자를 나누고, 어느 구간에서 요청을 제한하고, 제한 결과를 어떻게 관측할지까지 같이 정해야 운영 기능이 된다.

이 글은 Spring Cloud Gateway RateLimiter가 Redis와 Lua script를 통해 요청을 제한하는 흐름을 운영 판단 기준 위주로 정리한 기록이다.

## 왜 Gateway에서 제한하는가

요청 제한은 여러 위치에서 할 수 있다.

| 위치 | 특징 |
| --- | --- |
| Web server | 애플리케이션 앞단에서 단순한 제한을 걸기 쉽다. |
| Load balancer | 인프라 단위에서 제한할 수 있지만 서비스별 정책 표현은 제한적이다. |
| API Gateway | route, 사용자, API key 같은 application context를 기준으로 제한하기 쉽다. |
| Application | 가장 세밀하지만 모든 서비스에 중복 구현될 수 있다. |

Spring Cloud Gateway의 `RequestRateLimiter`는 route와 key를 기준으로 요청을 제한한다. 분산 환경에서는 여러 Gateway instance가 같은 기준을 봐야 하므로 Redis를 사용한다.

## 내부 흐름

Gateway filter의 흐름은 크게 네 단계다.

```text
request
  -> KeyResolver가 제한 기준 key 추출
  -> RateLimiter가 routeId + key로 허용 여부 계산
  -> 허용이면 다음 filter로 전달
  -> 거부면 configured status code 반환
```

실제 설정에서는 `KeyResolver`가 중요하다. IP로 제한할 수도 있고, 사용자 ID, API key, tenant ID로 제한할 수도 있다.

```java
@Bean
KeyResolver userKeyResolver() {
    return exchange -> Mono.just(
        exchange.getRequest().getQueryParams().getFirst("userId")
    );
}
```

운영에서는 query parameter만으로 사용자를 구분하는 방식은 약하다. 인증된 principal, API key, tenant header처럼 위조 가능성이 낮은 값을 쓰는 편이 낫다.

## Token bucket 설정

Spring Cloud Gateway의 RedisRateLimiter는 token bucket 방식으로 동작한다.

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: api_server
          uri: http://localhost:8081
          predicates:
            - Path=/**
          filters:
            - name: RequestRateLimiter
              args:
                key-resolver: "#{@userKeyResolver}"
                redis-rate-limiter.replenishRate: 1
                redis-rate-limiter.burstCapacity: 10
                redis-rate-limiter.requestedTokens: 5
```

각 값은 이렇게 해석했다.

| 설정 | 의미 |
| --- | --- |
| `replenishRate` | 초당 채워지는 token 수 |
| `burstCapacity` | bucket이 담을 수 있는 최대 token 수 |
| `requestedTokens` | 요청 1회가 소비하는 token 수 |

위 설정에서는 bucket 최대치가 10이고, 요청마다 5 token을 쓴다. token은 초당 1개씩 회복된다. 연속 요청을 두 번 보내면 token이 거의 비고, 회복되기 전에 다시 요청하면 429가 반환된다.

## Redis에는 무엇이 남는가

Gateway는 Redis에 남은 token 수와 마지막 갱신 시각을 기록한다. key는 route와 resolver 결과를 조합해서 만들어진다.

```text
request_rate_limiter.{routeId}.{key}.tokens
request_rate_limiter.{routeId}.{key}.timestamp
```

요청이 들어올 때마다 Lua script가 실행되어 token을 채우고, 요청에 필요한 token을 뺄 수 있는지 판단한다. Lua script를 쓰는 이유는 읽기, 계산, 쓰기를 Redis 안에서 원자적으로 처리하기 위해서다.

```text
read current tokens
read last refreshed timestamp
calculate refill
check requested tokens
write new token count
write new timestamp
return allowed / remaining
```

이 구조 덕분에 Gateway instance가 여러 대여도 같은 Redis를 바라보면 제한 기준을 공유할 수 있다.

## 운영에서 봐야 할 것

RateLimiter를 붙였다고 바로 안전해지는 것은 아니다. 최소한 아래 기준을 정해야 한다.

| 질문 | 운영 기준 |
| --- | --- |
| key는 무엇인가 | IP인지 사용자 ID인지 tenant인지 정한다. |
| 거부 응답은 무엇인가 | 보통 429를 쓰고, client가 재시도할 수 있게 header를 남긴다. |
| Redis 장애 시 어떻게 할 것인가 | fail-open, fail-closed 중 정책을 정한다. |
| 제한 기준은 어디에 기록되는가 | route별 설정과 변경 이력을 남긴다. |
| 관측 지표는 무엇인가 | allowed, denied, Redis latency, 429 count를 본다. |

특히 Redis 장애 시 정책이 중요하다. Redis를 못 읽는다고 모든 요청을 막으면 장애 전파가 커질 수 있고, 반대로 모두 허용하면 보호 장치가 사라진다. 서비스 성격에 따라 선택이 달라진다.

## 주의한 점

원문을 작성할 때 봤던 Lua script에는 `setex`가 사용되고 있었다. Redis 문서에서는 `SET`에 expiration 옵션을 붙이는 방식을 권장한다. 라이브러리가 어떤 Redis command를 쓰는지, 사용하는 Redis 버전에서 경고나 호환성 문제가 없는지 확인할 필요가 있다.

또 하나는 자동 구성이다. Spring Cloud Gateway는 Redis 관련 bean이 있으면 Gateway Redis auto configuration을 통해 RedisRateLimiter 구성을 붙일 수 있다. 그래서 dependency와 bean 상태가 설정 적용 여부에 영향을 준다.

## 정리

Spring Cloud Gateway RateLimiter를 쓸 때 핵심은 설정 세 줄이 아니다.

```text
누구를 기준으로 제한할 것인가
얼마나 허용할 것인가
초과와 장애를 어떻게 관측할 것인가
```

이 세 가지가 정리되어야 요청 제한이 운영 정책이 된다. 그렇지 않으면 “429가 나오는 기능”만 붙고, 실제로 보호하고 싶은 자원이나 사용자 경험은 설명하기 어렵다.

원문: [Request Rate Limiter](https://velog.io/@kimgunwooo/Request-Rate-Limiter-feat.-Spring-Cloud-Gateway)
