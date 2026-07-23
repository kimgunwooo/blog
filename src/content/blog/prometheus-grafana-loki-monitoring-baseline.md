---
title: 'Prometheus, Grafana, Loki로 Spring Boot 관측 기준 잡기'
description: 'Actuator, Prometheus scrape, Grafana dashboard, Slack alert, Loki log 수집을 운영 기준으로 다시 정리했다.'
category: 'Observability'
pubDate: '2024-08-12'
updatedDate: '2026-07-23'
tags: ['prometheus', 'grafana', 'loki', 'spring-boot', 'alerting']
---

처음 모니터링을 붙일 때는 “대시보드가 보이면 됐다”고 생각하기 쉽다. 하지만 운영에서 필요한 것은 화면이 아니라 기준이다. 어떤 metric을 수집하고, 어떤 상태에서 알림을 보내며, 로그와 metric을 어떻게 같이 볼지 정해야 한다.

이 글은 Spring Boot 애플리케이션에 Prometheus, Grafana, alert, Loki를 붙이며 관측 기준을 어떻게 잡아야 하는지 정리한 기록이다.

## 관측 범위

서비스 운영에서 관측 대상은 하나가 아니다.

| 범위 | 예시 |
| --- | --- |
| 서버 | CPU, memory, disk, network |
| 애플리케이션 | health, request latency, error count, JVM metric |
| 데이터베이스 | connection, query latency, lock, storage |
| 로그 | error log, request log, domain event |
| 알림 | 장애 전조, 장애 발생, 복구 |

처음에는 Spring Boot 애플리케이션 하나를 기준으로 시작했다. Actuator로 metric endpoint를 열고, Prometheus가 scrape하고, Grafana가 보여주고, 필요한 경우 Slack으로 알림을 보내는 구조다.

```text
Spring Boot Actuator
  -> Prometheus scrape
  -> Grafana dashboard
  -> Alert rule
  -> Slack notification
```

로그는 Loki로 보냈다.

```text
Spring Boot logback
  -> Loki
  -> Grafana Explore
```

## Actuator 노출

Spring Boot에서는 Actuator로 health와 metric endpoint를 열 수 있다.

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
  endpoint:
    health:
      show-details: when_authorized
    prometheus:
      enabled: true
```

초기 실습에서는 `include: *`나 `show-details: always`를 쓰기 쉽다. 하지만 운영 환경에서는 필요한 endpoint만 열고, health 상세 정보는 인증된 사용자에게만 보이게 해야 한다.

Actuator를 애플리케이션 포트와 분리하는 것도 한 방법이다.

```properties
server.port=8080
management.server.port=19090
```

이렇게 하면 서비스 트래픽과 운영 endpoint 접근 경로를 분리할 수 있다.

## Prometheus scrape

Prometheus는 pull 방식으로 metric을 가져온다. Spring Boot 애플리케이션의 `/actuator/prometheus`를 scrape target으로 둔다.

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'spring-boot'
    metrics_path: '/actuator/prometheus'
    static_configs:
      - targets: ['host.docker.internal:8080']
```

Docker Compose 실습에서는 Prometheus container가 host의 Spring Boot 앱에 접근해야 해서 `host.docker.internal`을 사용했다. 실제 Kubernetes 환경에서는 Service DNS나 ServiceMonitor 같은 방식으로 바뀐다.

검증 기준은 간단했다.

```text
Prometheus target이 UP인가
scrape interval이 의도한 값인가
Spring Boot metric이 query 되는가
```

## Grafana dashboard

Grafana에서는 Prometheus를 data source로 등록하고 Spring Boot/JVM dashboard를 붙였다. 이미 공개된 dashboard template을 가져오면 JVM memory, GC, HTTP latency, thread, DB connection 같은 지표를 빠르게 볼 수 있다.

대시보드는 보기 좋게 만드는 것보다 질문에 답하게 만드는 것이 중요하다.

- 지금 서비스가 살아 있는가
- 요청이 느려졌는가
- error가 늘었는가
- JVM memory나 GC가 이상한가
- DB connection pool이 고갈되고 있는가

처음 dashboard를 만들 때는 모든 panel을 보려고 하기보다, 장애 판단에 쓰는 panel만 남기는 편이 낫다.

## Slack alert

처음 만든 알림은 `up < 1` 기준이었다. Prometheus에서 target이 내려가면 Grafana alert가 Slack으로 알림을 보낸다.

```text
metric: up
filter: job="spring-boot"
condition: below 1
```

이 알림은 서비스가 이미 죽었는지 확인하는 데는 도움이 된다. 다만 운영 관점에서는 너무 늦은 알림일 수 있다. 실제로는 죽기 전에 볼 수 있는 전조 지표가 더 중요하다.

예를 들면 아래 기준이 더 운영적이다.

- 5xx 비율 증가
- p95 latency 증가
- DB connection pool 사용률 증가
- JVM memory 사용률 지속 상승
- log error count 증가

알림은 많을수록 좋은 것이 아니다. 사람이 행동할 수 있는 알림이어야 한다.

## Loki log 수집

Loki는 label 기반으로 log를 저장하고 Grafana에서 조회하게 해준다. 당시 구성에서는 `loki-logback-appender`를 사용해 Spring Boot logback에서 Loki로 직접 전송했다.

```xml
<appender name="LOKI" class="com.github.loki4j.logback.Loki4jAppender">
  <http>
    <url>http://localhost:3100/loki/api/v1/push</url>
  </http>
  <format>
    <label>
      <pattern>app=my-app,host=${HOSTNAME}</pattern>
    </label>
    <message class="com.github.loki4j.logback.JsonLayout" />
  </format>
</appender>
```

직접 appender를 붙이는 방식은 빠르게 실습하기 좋다. 다만 운영에서는 application이 Loki 장애에 영향을 받지 않게 buffering, retry, agent 방식도 같이 검토해야 한다.

Kubernetes라면 보통 아래 구조가 더 자연스럽다.

```text
container stdout
  -> log agent
  -> Loki
```

애플리케이션은 stdout에 로그를 남기고, 수집 agent가 책임지는 구조가 운영 경계를 나누기 쉽다.

## 정리

이 실습에서 남긴 기준은 아래다.

1. Actuator는 필요한 endpoint만 열고 보호한다.
2. Prometheus target UP만 보지 말고 scrape 지연과 metric 유무를 확인한다.
3. Grafana dashboard는 장애 질문에 답하는 panel 위주로 줄인다.
4. Slack alert는 사람이 행동할 수 있는 조건만 남긴다.
5. Loki는 log 수집 경로와 애플리케이션 장애 전파 가능성을 같이 본다.

모니터링은 도구 목록이 아니라 운영 질문을 수치로 바꾸는 작업이다. “대시보드를 만들었다”보다 “이 상태에서 무엇을 판단할 수 있는가”가 더 중요하다.

원문: [모니터링 시스템](https://velog.io/@kimgunwooo/TIL-%EB%AA%A8%EB%8B%88%ED%84%B0%EB%A7%81-%EC%8B%9C%EC%8A%A4%ED%85%9C-Prometheus-Grafana-Slack-Loki)
