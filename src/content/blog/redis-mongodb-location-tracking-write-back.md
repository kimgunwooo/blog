---
title: '위치 추적 API에서 Redis Write Back을 적용한 이유'
description: '3초 단위 좌표 저장/조회 요청에서 MongoDB 병목을 Redis cache와 write back 구조로 줄인 과정을 정리했다.'
category: 'Performance'
pubDate: '2024-06-03'
createdAt: '2026-07-23T11:25:24+09:00'
updatedDate: '2026-07-23'
tags: ['redis', 'mongodb', 'cache', 'write-back', 'locust']
---

위치 추적 기능은 데이터 하나의 크기는 작지만 요청이 반복해서 들어온다. 한 배달이 20분 동안 진행되고, 클라이언트가 3초마다 좌표를 보낸다면 한 건의 tracking에도 수백 번의 write/read가 생긴다.

이 글은 location tracking module에서 MongoDB write/read 병목을 Redis cache와 write back 구조로 줄였던 과정을 병목 판단과 cache 전략 위주로 정리한 기록이다.

## 문제

요구사항은 단순했다.

```text
iOS client가 3초마다 좌표를 보낸다.
tracking 중에는 좌표를 저장한다.
사용자는 현재 tracking 좌표를 조회한다.
tracking 종료 후에는 좌표 기록을 보관한다.
```

한 tracking을 최대 20분으로 보면 대략 아래 요청이 생긴다.

| 항목 | 계산 |
| --- | --- |
| 좌표 저장 | 20분 * 60초 / 3초 = 400회 |
| 좌표 조회 | 비슷한 간격이면 최대 400회 |
| 데이터 크기 | 위도, 경도 중심의 작은 payload |

초기 구조는 단순했다.

```text
API
  -> MongoDB에서 tracking 조회
  -> tracking 상태와 권한 확인
  -> MongoDB에 coordinate 저장
  -> MongoDB에서 coordinate 조회
```

문제는 매 요청마다 tracking 정보를 MongoDB에서 읽고, coordinate도 MongoDB에 바로 쓰는 구조였다. 요청 수가 늘면 MongoDB가 모든 경로의 중심 병목이 된다.

## 1차 개선: Look Aside cache

먼저 tracking 정보를 Redis에 캐싱했다.

```text
request
  -> Redis에서 tracking 조회
  -> 없으면 MongoDB 조회 후 Redis에 저장
  -> tracking 상태와 key 검증
  -> coordinate 저장
```

이 구조는 반복 조회되는 tracking metadata에는 효과가 있다. 한 tracking이 시작되면 끝날 때까지 같은 tracking ID와 API key 검증이 반복되기 때문이다.

하지만 좌표 write는 여전히 MongoDB로 계속 들어갔다. 읽기 병목 일부는 줄었지만, write 부하는 크게 남았다.

## 2차 개선: Write Through 검토

다음으로 Redis와 MongoDB에 동시에 쓰는 Write Through 구조를 검토했다.

```text
write request
  -> Redis 저장
  -> MongoDB 저장
```

이 방식은 읽기 경로를 Redis 중심으로 바꾸는 데 도움이 된다. 다만 write 자체는 MongoDB에도 계속 발생한다. 좌표처럼 3초마다 추가되는 데이터에는 MongoDB write 부하를 충분히 줄이지 못했다.

## 3차 개선: Write Back

최종적으로 좌표를 Redis에 먼저 쌓고, tracking 종료 시점에 MongoDB로 bulk 저장하는 구조를 적용했다.

```text
tracking 중
  -> coordinate를 Redis에 저장
  -> 조회도 Redis에서 수행

tracking 종료
  -> Redis coordinate 목록 조회
  -> MongoDB에 bulk save
  -> tracking 종료 상태 저장
```

이 선택의 이유는 domain 조건이었다.

- 한 tracking은 길어도 약 20분이다.
- 좌표 수는 대략 400개 수준이다.
- tracking 중에는 최신 좌표 조회가 더 중요하다.
- 영구 보관은 tracking 종료 후 필요하다.

그래서 schedule 기반 flush보다 “tracking 종료 시점 bulk 저장”이 더 단순했다.

## 비동기 종료 처리

종료 시점에 Redis에서 MongoDB로 좌표를 옮기는 작업은 한 번에 몰릴 수 있다. 그래서 비동기 처리와 재시도를 붙였다.

```java
public void endTracking(TrackingContext context) {
    TrackingRedisEntity trackingCache = checkTracking(context);
    retryEndTrackingAsync(trackingCache.trackingId(), 0);
}
```

실제 작업은 tracking 종료 상태를 저장한 뒤, Redis에 있는 coordinate를 읽어 MongoDB에 `saveAll`하는 흐름이다. 실패 시에는 Exponential Backoff와 Jitter를 사용해 재시도했다.

중요한 점은 순서다.

```text
tracking 종료 상태 반영
  -> Redis coordinate 조회
  -> MongoDB bulk save
  -> 실패 시 재시도
```

이 순서를 잘못 잡으면 종료된 tracking이 다시 쓰이거나, 좌표는 저장됐지만 tracking 상태가 어긋나는 문제가 생긴다.

## 성능 테스트

Locust로 세 가지 구조를 비교했다.

| 구조 | 관찰 |
| --- | --- |
| MongoDB only | 짧은 시간 안에 처리하지 못한 request가 쌓이고 timeout 증가 |
| Redis cache | tracking metadata 조회 부하는 줄었지만 종료 처리와 write 부하가 남음 |
| Redis Write Back | 처리량 증가, MongoDB CPU 부하 감소, 종료 시점 bulk 작업은 여전히 관찰 필요 |

![MongoDB only load test](/images/blog/redis-mongodb-location-tracking-write-back/mongodb-only-load-test.png)

MongoDB만 사용한 구조에서는 요청이 늘면서 응답 시간이 크게 흔들렸다. 매 요청마다 tracking 조회와 coordinate 저장이 MongoDB로 몰렸기 때문이다.

![Redis write back load test](/images/blog/redis-mongodb-location-tracking-write-back/write-back-load-test.png)

원문 실험에서는 1000 user, worker 3개 조건에서 Write Back 적용 후 처리량이 2배 이상 개선되고, p95-p99 응답 시간도 안정적인 범위로 내려왔다. MongoDB CPU 사용률도 가장 크게 달라졌다.

정확한 수치보다 중요한 것은 병목의 위치가 바뀌었다는 점이다.

```text
이전 병목: 매 요청마다 MongoDB read/write
이후 병목: 종료 시점 bulk save와 Redis 안정성
```

성능 개선은 병목을 없애는 일이 아니라, 더 관리 가능한 위치로 옮기는 일에 가깝다.

## 리스크

Write Back은 장점만 있는 구조가 아니다.

| 리스크 | 대응 |
| --- | --- |
| Redis 장애 시 미저장 좌표 유실 | Redis Sentinel/replication, backup, flush 정책 |
| 종료 작업 실패 | retry, dead letter 성격의 실패 기록 |
| bulk save 지연 | queue size, worker 수, retry budget 관측 |
| 조회 일관성 | tracking 중 조회 source를 Redis로 명확히 고정 |

추가로 Redis Sentinel을 통해 Redis 단일 장애점을 줄이는 방향을 검토했다. MongoDB 역시 replica set이나 backup/restore 기준이 필요하다.

## Local cache를 쓰지 않은 이유

Local cache도 검토했지만 좌표 데이터에는 맞지 않았다. 좌표는 자주 추가되고 여러 서버가 같은 tracking을 볼 수 있다. instance별 local cache에 좌표가 흩어지면 일관성이 깨진다.

Tracking metadata처럼 변경 빈도가 낮은 값은 local cache 후보가 될 수 있다. 하지만 종료 상태가 바뀌었을 때 모든 instance의 local cache가 즉시 알지 못하면 종료된 tracking에 계속 좌표를 쓰는 문제가 생길 수 있다.

그래서 당시 구조에서는 Redis를 공유 cache로 두는 편이 더 안전했다.

## 정리

이 개선에서 남은 기준은 아래다.

1. 요청 빈도와 데이터 생명주기를 먼저 계산한다.
2. 반복 조회되는 metadata와 계속 추가되는 coordinate를 분리한다.
3. Write Back은 write 부하를 줄이지만 유실/flush 실패 리스크를 만든다.
4. 성능 테스트는 평균 응답 시간보다 병목 위치 변화를 봐야 한다.
5. cache는 빠른 저장소가 아니라 일관성 기준을 같이 설계해야 하는 저장 경로다.

Redis를 붙였기 때문에 빨라진 것이 아니다. Redis에 무엇을 두고, MongoDB에는 언제 영구 저장할지 domain 기준으로 나눴기 때문에 효과가 있었다.

원문: [location tracking module 성능 개선 과정](https://velog.io/@kimgunwooo/%EC%84%B1%EB%8A%A5-%EA%B0%9C%EC%84%A0-%EA%B3%BC%EC%A0%95-feat.-Redis-MongoDB)
