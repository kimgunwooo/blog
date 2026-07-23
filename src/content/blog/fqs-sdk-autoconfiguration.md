---
title: 'Spring Boot AutoConfiguration으로 FQS SDK 도입 비용 줄이기'
description: 'B2B 대기열 서비스를 외부 개발자가 쉽게 붙일 수 있도록 Spring Boot AutoConfiguration과 JitPack 배포를 적용한 기록이다.'
category: 'Automation'
pubDate: '2025-01-25'
updatedDate: '2026-07-23'
tags: ['fqs', 'spring-boot', 'autoconfiguration', 'sdk', 'jitpack']
---

FQS는 B2B 개발자에게 대기열 기능을 제공하는 프로젝트였다. 대기열 서버를 만들고 Gateway route를 붙이는 것만으로는 부족했다. 실제 사용하는 사람은 외부 서비스 개발자이고, 그 개발자가 매번 FQS API 호출 순서와 secret key 처리 방식을 직접 구현해야 한다면 도입 비용이 커진다.

그래서 별도 SDK를 만들기로 했다. 목표는 기능을 많이 넣는 것이 아니라, 고객사 개발자가 실수하기 쉬운 부분을 줄이는 것이었다.

이 글은 반복 구현을 SDK와 AutoConfiguration으로 감추고, 외부 개발자가 더 적은 설정으로 대기열 기능을 붙이게 만든 도구화 기록이다.

## 문제

FQS를 직접 HTTP API로 붙이면 고객사 서비스 쪽에 반복 코드가 생긴다.

```text
queue 생성
  -> queue name 저장
  -> secret key 저장
  -> 대기열 진입 요청
  -> 현재 순번 조회
  -> 통과 여부 확인
  -> 실패/재시도 처리
```

각 팀이 이 흐름을 직접 구현하면 아래 문제가 생긴다.

| 문제 | 설명 |
| --- | --- |
| 반복 구현 | queue 진입, 순번 조회, secret key 전달 코드가 서비스마다 생김 |
| 설정 실수 | endpoint, queue name, secret key를 잘못 넣을 수 있음 |
| 보안 위험 | secret key를 외부에 노출하거나 client로 넘길 가능성 있음 |
| 변경 비용 | FQS API가 바뀔 때 각 서비스 코드를 다시 고쳐야 함 |

SDK는 이 반복을 줄이기 위한 장치였다. 고객사 입장에서는 dependency를 추가하고 설정만 넣으면, 필요한 client bean이 자동으로 등록되는 흐름이 가장 자연스럽다.

## AutoConfiguration을 선택한 이유

Spring Boot 프로젝트에서 라이브러리를 사용할 때 보통 기대하는 경험은 단순하다.

```text
dependencies {
    implementation 'some.library:name:version'
}
```

dependency를 추가하고 설정을 넣으면 필요한 bean이 자동 등록된다. FQS SDK도 이 경험을 맞추고 싶었다.

직접 `@Bean`을 등록하게 만들 수도 있다.

```java
@Bean
public FqsClient fqsClient() {
    return new FqsClient(...);
}
```

하지만 SDK를 쓰는 모든 서비스가 이 코드를 반복해야 한다. 그래서 Spring Boot AutoConfiguration을 사용했다.

```text
application start
  -> dependency jar 로드
  -> AutoConfiguration.imports 후보 조회
  -> FQS SDK configuration 로드
  -> 필요한 client/properties bean 등록
```

## 등록 흐름

Spring Boot는 `@SpringBootApplication`을 통해 component scan과 auto configuration을 같이 수행한다. 개발자가 만든 component가 먼저 등록되고, 이후 `@EnableAutoConfiguration` 흐름에서 자동 구성 후보를 읽는다.

Spring Boot 3 기준으로 AutoConfiguration 클래스는 아래 경로에 등록한다.

```text
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

FQS SDK에서는 이 파일에 SDK 설정 클래스를 등록했다.

![FQS SDK AutoConfiguration imports](/images/blog/fqs-sdk-autoconfiguration/autoconfiguration-imports.png)

이렇게 하면 SDK jar가 classpath에 올라왔을 때, Spring Boot가 해당 설정 클래스를 자동 구성 후보로 읽을 수 있다.

## SDK가 숨겨야 할 것

SDK를 만들 때 중요한 것은 API를 전부 감싸는 것이 아니었다. 사용자가 매번 틀릴 수 있는 부분을 SDK 안쪽으로 숨기는 것이었다.

| SDK 책임 | 이유 |
| --- | --- |
| endpoint 설정 | 서비스마다 FQS 서버 주소를 직접 조합하지 않게 함 |
| queue name 관리 | 생성된 queue 이름을 일관된 방식으로 전달 |
| secret key 전달 | client 외부로 secret key가 노출되지 않게 함 |
| 요청 client 제공 | HTTP 호출 세부 구현을 서비스 코드에서 제거 |
| 실패 응답 처리 | 공통 예외/재시도 기준을 SDK에서 통일 |

사용자는 설정만 넣고 필요한 메서드를 호출하는 구조가 좋다.

```yaml
fqs:
  endpoint: https://fqs.example.com
  queue-name: concert-ticketing
  secret-key: ${FQS_SECRET_KEY}
```

서비스 코드에서는 FQS의 내부 API 순서를 몰라도 된다.

```java
fqsClient.enter(userId);
fqsClient.getPosition(userId);
```

이 정도의 추상화가 적당했다. 모든 정책을 SDK 안에 넣으면 오히려 고객사 서비스의 요구를 막을 수 있다. SDK는 공통 실수를 줄이고, 정책 결정은 FQS 서버와 고객사 설정에 남기는 편이 낫다.

## 배포 선택

SDK는 jar 파일을 직접 내려받아 넣는 방식으로 배포하면 사용성이 떨어진다. Spring 생태계에서는 Gradle/Maven dependency로 가져오는 방식이 자연스럽다.

당시에는 세 가지를 비교했다.

| 선택지 | 장점 | 판단 |
| --- | --- | --- |
| Maven Central | 가장 표준적인 공개 저장소 | 배포 절차가 상대적으로 무거움 |
| Nexus | 사내 저장소로 통제 가능 | 별도 운영 비용과 관리가 필요 |
| JitPack | GitHub repository/tag 기반으로 빠르게 배포 가능 | 장기 운영/안정성은 별도 검토 필요 |

팀 프로젝트 기간과 목적을 생각하면 JitPack이 가장 현실적이었다. GitHub repository와 release tag를 기준으로 빠르게 dependency를 가져올 수 있었다.

![FQS SDK JitPack getting started](/images/blog/fqs-sdk-autoconfiguration/jitpack-getting-started.png)

사용자는 `jitpack.io` repository를 추가하고 SDK dependency를 넣으면 된다.

```text
repositories {
    mavenCentral()
    maven { url 'https://jitpack.io' }
}

dependencies {
    implementation 'com.github.kimgunwooo:FQS-sdk:${version}'
}
```

JitPack은 빠른 실험과 팀 프로젝트에는 잘 맞았다. 다만 실제 운영용 SDK라면 versioning, changelog, backward compatibility, 배포 실패 시 대응까지 더 엄격하게 봐야 한다.

## 버전 관리

SDK는 한 번 배포하면 사용하는 서비스가 생긴다. 그래서 API 변경이 곧 고객사 코드 변경으로 이어질 수 있다.

간단한 기준은 아래처럼 잡을 수 있다.

1. public method signature는 쉽게 바꾸지 않는다.
2. 설정 key는 삭제보다 deprecate 기간을 둔다.
3. FQS server API 변경 시 SDK와 server compatibility를 같이 기록한다.
4. release tag마다 README 사용 예시를 맞춘다.
5. 문제가 생기면 이전 version으로 되돌릴 수 있어야 한다.

GitHub Actions와 GitHub Release를 같이 쓰면 PR merge 이후 tag/release를 만들고, JitPack에서 해당 version을 가져오게 할 수 있다. 당시 프로젝트에서는 많은 버전을 운영하지는 않았지만, 적어도 rollback 가능한 단위가 생긴다는 점이 중요했다.

## 정리

FQS SDK에서 중요한 것은 Spring Boot 내부 구조를 많이 쓰는 것이 아니었다. 외부 개발자가 FQS를 붙일 때 실수할 수 있는 지점을 줄이는 것이었다.

남은 기준은 아래다.

1. SDK는 기능보다 도입 경험을 줄이는 장치다.
2. AutoConfiguration을 쓰면 dependency 추가만으로 필요한 bean을 등록할 수 있다.
3. 설정 key, secret key, endpoint 조합은 SDK 안에서 일관되게 다뤄야 한다.
4. JitPack은 빠른 배포에는 맞지만, 장기 운영 SDK라면 배포 안정성과 version 정책을 더 봐야 한다.
5. SDK의 public API는 고객사 코드와의 계약이므로 쉽게 바꾸면 안 된다.

대기열 서비스는 서버만 잘 만든다고 끝나지 않는다. 고객사 개발자가 안전하게 붙일 수 있는 인터페이스까지 있어야 실제 제품처럼 쓸 수 있다.

원문: [FQS 라이브러리 만들기](https://velog.io/@kimgunwooo/FQS-%EB%9D%BC%EC%9D%B4%EB%B8%8C%EB%9F%AC%EB%A6%AC-%EB%A7%8C%EB%93%A4%EA%B8%B0)
