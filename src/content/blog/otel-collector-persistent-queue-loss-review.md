---
title: 'OTel Collector persistent queue는 유실을 어디까지 줄여줄까'
description: 'Collector 재시작, backend 장애, filelog offset 관점에서 persistent queue의 효과와 한계를 정리했다.'
category: 'Observability'
pubDate: '2026-07-04'
tags: ['opentelemetry', 'collector', 'persistent-queue', 'observability']
---

OpenTelemetry Collector에서 persistent queue를 켜면 telemetry가 덜 유실될 것 같지만, 어디까지 보호되는지는 따로 확인해야 한다. queue에 들어가기 전에 죽는 경우, queue 용량을 넘는 경우, retry 시간이 끝나는 경우는 다르게 봐야 한다.

이 글은 Collector persistent queue와 file storage extension을 켰을 때 어떤 상황에서 효과가 있고, 어떤 상황에서는 여전히 유실될 수 있는지 정리한 메모다.

## 문제

Collector가 telemetry를 받아 외부 backend로 내보낼 때 exporter 장애가 발생하면 메모리 queue만으로는 버틸 수 있는 시간이 짧다. Pod 재시작까지 겹치면 아직 전송하지 못한 데이터가 사라질 수 있다.

persistent queue를 켜면 디스크에 queue를 남길 수 있지만, 디스크 사용량, 재시작 복구 시간, backpressure 동작을 함께 봐야 한다. 단순히 옵션을 켰다는 사실만으로 운영 안전성이 생기지는 않는다.

## 실험/검증

검증은 샘플 앱에서 일정한 간격으로 trace와 log를 생성하고, Collector exporter의 목적지를 일시적으로 막는 방식으로 진행했다. 실제 backend 주소와 인증 값은 사용하지 않고 문서에는 일반화된 이름만 적는다.

비교 조건은 두 가지다.

- 메모리 queue만 사용
- persistent queue와 file storage extension 사용

각 조건에서 exporter 장애, Collector Pod 재시작, backend 복구 순서를 만들어 데이터가 얼마나 전달되는지 봤다. payload에는 개인 정보나 내부 식별자를 넣지 않고 synthetic service name만 사용했다.

## 결과

persistent queue를 켠 경우 짧은 exporter 장애와 Collector 재시작을 더 잘 견뎠다. backend가 복구된 뒤 queue에 남아 있던 일부 telemetry가 다시 전송됐다.

다만 queue가 무한한 보호막은 아니었다. 장애 시간이 길어지면 디스크 한도와 retry 설정에 따라 drop이 발생했다. 특히 queue directory 권한이나 volume 설정이 맞지 않으면 Collector가 시작 단계에서 실패할 수 있었다.

운영 판단으로는 persistent queue를 기본값처럼 켜기보다, 보관 가능한 데이터량과 허용 가능한 복구 시간을 먼저 정하는 편이 낫다.

## 한계

샘플 트래픽은 실제 운영 트래픽보다 단순하다. burst traffic, backend rate limit, 네트워크 partition이 길게 이어지는 상황은 충분히 다루지 못했다.

또한 검증은 홈 랩의 작은 PersistentVolume 기준이라 cloud storage class나 고성능 디스크에서의 결과와 다를 수 있다.

## 다음 개선

다음 개선은 장애 시간을 단계별로 늘리고, queue size와 dropped telemetry 수를 dashboard로 남기는 것이다. Collector 자체 metric을 함께 수집해 queue가 쌓이는 순간과 drop이 시작되는 순간을 분리해서 보려고 한다.

다음에는 Collector self-metrics를 같이 보면서 queue가 쌓이는 순간과 drop이 시작되는 순간을 분리해서 확인할 계획이다.
