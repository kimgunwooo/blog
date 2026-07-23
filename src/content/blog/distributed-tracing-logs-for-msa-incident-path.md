---
title: '분산 추적과 로그를 붙여야 MSA 장애를 따라갈 수 있다'
description: '서비스 간 호출이 나뉘었을 때 trace ID, span, Zipkin, 로그 상관관계가 왜 필요한지 정리했다.'
category: 'Observability'
pubDate: '2024-08-03'
updatedDate: '2026-07-23'
tags: ['msa', 'distributed-tracing', 'zipkin', 'trace-id', 'logging']
---

MSA에서는 하나의 요청이 한 서비스 안에서 끝나지 않는다. Gateway를 지나고, 주문 서비스가 상품 서비스를 부르고, 다시 결제나 배송 서비스로 이어질 수 있다. 이때 장애가 나면 “어느 서버 로그를 봐야 하는가”부터 막히기 쉽다.

각 서비스 로그가 따로 있으면 부분적인 사실만 보인다. 분산 추적은 이 조각들을 하나의 요청 흐름으로 이어서 보는 기준이다.

Spring Cloud 기반 order-service, product-service 예제로 trace ID, span, Zipkin, 로그 상관관계를 확인했던 내용을 운영 관점으로 다시 정리했다.

## 로그만으로 부족한 지점

모놀리식에서는 한 요청이 하나의 애플리케이션 로그 안에 남는다. 물론 복잡한 서비스에서는 이것만으로도 어렵지만, 최소한 한 프로세스 안에서 흐름을 따라갈 수 있다.

MSA에서는 요청이 네트워크를 지나며 여러 서비스로 나뉜다.

```text
client request
  -> gateway
  -> order-service
  -> product-service
  -> database
```

이 구조에서 `product-service`가 느려졌다고 해도 사용자는 `gateway`의 응답 지연으로 느낀다. `order-service` 로그에는 외부 호출 지연만 보일 수 있고, `product-service` 로그에는 자기 API가 느렸다는 사실만 남을 수 있다.

그래서 서비스별 로그를 모으는 것만으로는 부족하다. 같은 요청에서 나온 로그라는 것을 묶을 수 있어야 한다.

## Trace와 Span

분산 추적에서는 요청 전체를 trace로 보고, 그 안의 개별 작업을 span으로 본다.

| 개념 | 의미 |
| --- | --- |
| trace | 하나의 요청이 시작해서 끝날 때까지의 전체 흐름 |
| span | 특정 서비스 호출, DB 조회, 외부 API 호출 같은 작업 단위 |
| traceId | 같은 요청에 속한 span을 묶는 ID |
| spanId | 각 작업 단위를 구분하는 ID |

예를 들어 주문 조회 요청은 하나의 trace가 되고, Gateway 처리, order-service API 처리, product-service 호출은 각각 span이 된다.

```text
trace: GET /orders/{id}

span 1: gateway route
span 2: order-service GET /orders/{id}
span 3: product-service GET /products/{id}
```

traceId가 유지되면 각 서비스의 로그와 span을 같은 요청으로 이어 볼 수 있다. 장애 분석에서 중요한 것은 “어느 서비스가 에러를 냈는가”뿐 아니라 “그 에러가 어느 요청 흐름에서 발생했는가”다.

## Zipkin으로 보는 흐름

실습에서는 order-service가 FeignClient로 product-service를 호출하는 구조를 만들고, Zipkin으로 요청 흐름을 확인했다.

```text
order-service
  -> product-service
  -> response
```

필요한 의존성은 actuator, Micrometer tracing bridge, Feign 계측, Zipkin reporter였다.

```text
implementation 'org.springframework.boot:spring-boot-starter-actuator'
implementation 'io.micrometer:micrometer-tracing-bridge-brave'
implementation 'io.github.openfeign:feign-micrometer'
implementation 'io.zipkin.reporter2:zipkin-reporter-brave'
```

Zipkin은 간단히 Docker로 띄웠다.

```bash
docker run -d -p 9411:9411 openzipkin/zipkin
```

애플리케이션에서는 span을 보낼 endpoint와 sampling 비율을 설정했다.

```yaml
management:
  zipkin:
    tracing:
      endpoint: "http://localhost:9411/api/v2/spans"
  tracing:
    sampling:
      probability: 1.0
```

실습 환경에서는 모든 요청을 보기 위해 sampling을 1.0으로 두었다. 운영에서는 트래픽 양과 저장 비용을 보고 조정해야 한다.

Zipkin에서 확인한 핵심은 단순했다.

```text
order-service: http get /order/{orderId}
  -> http get
  -> product-service: http get /product/{id}
```

![Zipkin trace detail](/images/blog/distributed-tracing-logs-for-msa-incident-path/zipkin-trace-detail.png)

이 화면을 보면 요청이 어떤 서비스를 거쳤고, 어느 구간에서 시간이 걸렸는지 확인할 수 있다. 서버가 2개인 실습에서는 크게 복잡하지 않지만, 서비스가 늘어날수록 이 차이는 커진다.

![Zipkin dependency graph](/images/blog/distributed-tracing-logs-for-msa-incident-path/zipkin-dependencies.png)

Dependencies 화면은 서비스 간 호출 관계를 더 건조하게 보여준다. 장애 분석에서는 trace detail로 느린 span을 보고, dependency graph로 반복되는 호출 방향을 확인하는 식으로 나눠 볼 수 있다.

## 로그에 같이 남겨야 하는 값

Trace UI만으로 모든 문제가 풀리지는 않는다. Trace는 호출 경로와 시간은 잘 보여주지만, 비즈니스 맥락은 로그에 더 많이 남는다.

그래서 로그에는 최소한 아래 값이 같이 있어야 한다.

- service name
- request path
- status code
- latency
- error type
- traceId
- spanId

예를 들어 같은 에러 로그라도 traceId가 있으면 Zipkin의 요청 흐름과 Loki 같은 로그 저장소의 원문 로그를 연결할 수 있다.

```text
metric: 5xx 증가를 확인
trace: 느린 구간이 product-service임을 확인
log: product-service에서 재고 조회 timeout 발생 확인
```

이렇게 metric, trace, log가 각각 다른 질문에 답한다.

| 도구 | 답하는 질문 |
| --- | --- |
| metric | 지금 이상한가 |
| trace | 어디서 느려졌는가 |
| log | 왜 실패했는가 |

## 놓치기 쉬운 부분

분산 추적을 붙여도 자동으로 운영 문제가 끝나지는 않는다.

1. sampling 때문에 드문 장애가 수집되지 않을 수 있다.
2. 비동기 메시지나 이벤트 경계에서는 trace context 전파를 따로 확인해야 한다.
3. 로그에 traceId가 빠지면 trace와 로그를 이어 보기 어렵다.
4. 민감한 사용자 정보나 token이 span tag와 log에 들어가지 않게 해야 한다.
5. Zipkin 자체 장애가 애플리케이션 요청 처리에 영향을 주지 않아야 한다.

특히 이벤트 기반 구조에서는 HTTP 호출처럼 흐름이 눈에 보이지 않는다. 메시지 발행 시점, 소비 시점, retry, dead letter queue까지 이어서 볼 수 있어야 한다.

## 정리

MSA에서 장애를 찾기 어려운 이유는 서비스가 많아서가 아니라, 요청 흐름이 끊겨 보이기 때문이다.

분산 추적은 이 흐름을 다시 이어준다. Metric은 이상 징후를 알려주고, trace는 느려진 구간을 좁히고, log는 실패한 이유를 설명한다. 셋 중 하나만 있으면 장애를 “느낌”으로 찾게 되고, 셋이 연결되면 요청 단위로 따라갈 수 있다.

서비스를 나눈다면 추적 기준도 같이 나눠서 설계해야 한다. Gateway, 내부 서비스, 외부 API, DB 호출이 같은 traceId로 이어질 때 MSA 장애를 실제로 따라갈 수 있다.

원문: [분산 추적, Spring Cloud Sleuth 및 로깅, Zipkin](https://velog.io/@kimgunwooo/TIL-%EB%B6%84%EC%82%B0-%EC%B6%94%EC%A0%81-Spring-Cloud-Sleuth-%EB%B0%8F-%EB%A1%9C%EA%B9%85-Zipkin)
