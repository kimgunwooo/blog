---
title: 'Spring Cloud Gateway 라우팅을 배포 없이 갱신하는 흐름'
description: '동적으로 생성된 대기열 서버를 Eureka에 등록하고, Redis에 저장한 route 정보를 Gateway에 반영하는 흐름을 정리했다.'
category: 'Network'
pubDate: '2024-10-27'
createdAt: '2026-07-23T11:25:24+09:00'
updatedDate: '2026-07-23'
tags: ['spring-cloud-gateway', 'eureka', 'route-locator', 'redis', 'fqs']
---

동적으로 queue server를 만들었다면 다음 문제는 라우팅이다. container가 떠도 Gateway가 그 서버를 모르면 외부 요청은 도달하지 못한다.

이 글은 FQS에서 Spring Cloud Gateway 라우팅을 배포 없이 갱신했던 실험을 다시 정리한 것이다. 전체 FQS 설계는 별도 케이스 스터디로 정리했고, 여기서는 Gateway route 갱신 흐름만 다룬다.

## 목표

대기열 생성 요청이 들어오면 queue server와 Redis가 새로 생성된다. 이때 Gateway도 새 route를 알아야 한다.

```text
queue create request
  -> queue server container start
  -> Eureka service register
  -> route metadata 저장
  -> Gateway route refresh
  -> client request routing
```

정적 YAML route만 사용하면 새 대기열이 생길 때마다 Gateway 설정을 바꾸고 다시 배포해야 한다. FQS에서는 그 방식이 맞지 않았다.

## Eureka 등록

동적으로 생성되는 queue server는 Eureka client로 등록되게 했다.

```yaml
eureka:
  client:
    service-url:
      defaultZone: http://eureka:19090/eureka/
```

Docker network 안에서 Eureka server에 접근해야 했기 때문에 container 이름을 기준으로 접근했다. queue server가 뜨면 health check를 통해 Eureka에 service instance로 등록된다.

여기까지는 service discovery 단계다. 하지만 Eureka에 등록됐다고 해서 Gateway route가 자동으로 원하는 path에 생기는 것은 아니다.

## route 정보를 외부 저장소에 둔 이유

정적 route 설정은 보통 YAML에 둔다.

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: queue-manage-service
          uri: lb://queue-manage-service
          predicates:
            - Path=/api/queue/**
```

FQS에서는 route가 런타임에 추가된다. 그래서 route 정보를 외부 저장소에 두고, Gateway가 그 정보를 읽어 route를 구성하게 했다.

저장소는 Redis를 사용했다.

이유는 단순했다.

- 이미 Gateway 주변에서 Redis를 쓰고 있었다.
- route 정보는 작은 key/value 성격이다.
- Gateway가 자주 읽어도 부담이 적다.
- RDB보다 변경 반영 실험이 빠르다.

물론 실제 운영이라면 Redis에 route를 둘 때도 영속성, 백업, stale route 삭제 기준을 정해야 한다.

## refresh endpoint

route 갱신을 트리거하기 위해 Gateway 쪽에 refresh endpoint를 만들었다.

```java
@Configuration
public class ApiRouteRouter {
    @Bean
    public RouterFunction<ServerResponse> route(ApiRouteHandler apiRouteHandler) {
        return RouterFunctions.route(
            GET("/routes/refresh-routes").and(accept(MediaType.APPLICATION_JSON)),
            apiRouteHandler::refreshRoutes
        );
    }
}
```

핸들러는 내부에서 `RefreshRoutesEvent`를 발행한다.

```java
@Component
public class GatewayRoutesRefresher implements ApplicationEventPublisherAware {
    private ApplicationEventPublisher applicationEventPublisher;

    @Override
    public void setApplicationEventPublisher(ApplicationEventPublisher publisher) {
        this.applicationEventPublisher = publisher;
    }

    public void refreshRoutes() {
        applicationEventPublisher.publishEvent(new RefreshRoutesEvent(this));
    }
}
```

이 이벤트가 발행되면 Gateway는 route cache를 다시 만들고, `RouteLocator`에서 route 정보를 다시 읽는다.

## Custom RouteLocator

RouteLocator는 Gateway route를 제공하는 계약이다. FQS에서는 Redis에 저장된 route 정보를 읽어서 route를 생성하는 구현체를 만들었다.

```java
@RequiredArgsConstructor
@Service
public class ApiRouteLocatorImpl implements RouteLocator {
    private final RouteLocatorBuilder routeLocatorBuilder;
    private final RouteService routeService;

    @Override
    public Flux<Route> getRoutes() {
        RouteLocatorBuilder.Builder routesBuilder = routeLocatorBuilder.routes();

        return routeService.getAll()
            .doOnNext(apiRoute ->
                routesBuilder.route(
                    String.valueOf(apiRoute.getRouteIdentifier()),
                    spec -> spec.path(apiRoute.getPath()).uri(apiRoute.getUri())
                )
            )
            .thenMany(routesBuilder.build().getRoutes());
    }
}
```

흐름은 아래처럼 볼 수 있다.

```text
RefreshRoutesEvent
  -> RouteLocator.getRoutes()
  -> routeService.getAll()
  -> Redis route metadata read
  -> RouteLocatorBuilder로 route 구성
  -> Gateway route cache 갱신
```

여기서 `path`와 `uri`만 설정하면 모든 HTTP method를 허용한다. method별 제한이 필요하면 predicate를 더 명시해야 한다.

## 검증한 것

실험에서 확인한 것은 세 가지다.

1. queue server가 container로 뜬 뒤 Eureka에 등록되는가
2. route metadata를 저장한 뒤 refresh endpoint 호출 시 Gateway가 새 route를 읽는가
3. 새 path로 들어온 요청이 동적으로 생성된 queue server로 전달되는가

이 구조가 동작하면 Gateway를 다시 배포하지 않아도 새 대기열 서버로 요청을 보낼 수 있다.

## 운영에서 주의할 점

동작하는 것과 운영 가능한 것은 다르다.

| 항목 | 봐야 할 것 |
| --- | --- |
| refresh endpoint | 외부에 열리면 안 된다. 인증/내부망 제한 필요 |
| route 저장소 | Redis 장애 시 기존 route를 어떻게 유지할지 결정 |
| stale route | 종료된 queue server의 route 삭제 기준 필요 |
| Eureka 지연 | instance 등록 전 route가 먼저 생기면 503/404 가능 |
| 관측 | route 갱신 시간, 실패 count, Gateway 4xx/5xx를 봐야 함 |

특히 route refresh는 생성 flow의 일부로 묶어서 봐야 한다.

```text
container start 성공
Eureka 등록 확인
route 저장 성공
refresh 성공
probe 요청 성공
```

이 중 하나라도 실패하면 “대기열 생성 성공”으로 응답하면 안 된다.

## 정리

Spring Cloud Gateway의 동적 라우팅은 `RefreshRoutesEvent`와 `RouteLocator`를 이용하면 구현할 수 있다. 하지만 핵심은 이벤트 발행 코드가 아니라 route lifecycle이다.

```text
route는 언제 생성되는가?
어디에 저장되는가?
언제 refresh되는가?
서버가 사라지면 route는 언제 삭제되는가?
refresh 실패는 어떻게 보이는가?
```

이 질문에 답해야 배포 없는 라우팅 갱신이 운영 기능이 된다.

원문: [Spring-Cloud-Gateway 동적 라우팅](https://velog.io/@kimgunwooo/TIL-Spring-Cloud-Gateway-%EB%8F%99%EC%A0%81-%EB%9D%BC%EC%9A%B0%ED%8C%85-%EB%B0%B0%ED%8F%AC%EC%97%86%EC%9D%B4)
