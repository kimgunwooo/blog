---
title: 'Docker multi-stage와 multi-platform build 정리'
description: '최종 runtime image를 줄이는 multi-stage build와 architecture별 image를 다루는 multi-platform build를 정리했다.'
category: 'Docker'
pubDate: '2026-07-05'
createdAt: '2026-07-22T13:49:49+09:00'
tags: ['docker', 'multi-stage', 'multi-platform', 'buildx']
---

Docker build 최적화는 cache hit만으로 끝나지 않는다. 최종 image에 무엇을 남길지, amd64와 arm64를 어떻게 빌드할지, cache를 architecture별로 어떻게 나눌지도 같이 봐야 한다.

이 글은 multi-stage build와 multi-platform build를 CI/CD 관점에서 정리한 메모다.

## multi-stage build는 왜 쓰는가

multi-stage build는 build 도구가 필요한 단계와 runtime에 필요한 결과물을 분리하는 방식이다.

```dockerfile
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline
COPY src ./src
RUN mvn package -DskipTests

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/target/app.jar app.jar
ENTRYPOINT ["java", "-jar", "app.jar"]
```

최종 image에는 아래만 들어간다.

```text
JRE
app.jar
entrypoint metadata
```

Maven, source, build cache, target 중간 파일은 최종 image에 들어가지 않는다.

장점은 명확하다.

- image size 감소
- attack surface 감소
- runtime 환경 단순화
- build 단계 cache 분리 가능

## multi-platform image는 tag 하나가 여러 manifest를 가리킨다

하나의 image tag가 항상 하나의 image만 가리키는 것은 아니다.

```text
app:1.0
  -> image index
    -> linux/amd64 manifest
    -> linux/arm64 manifest
```

사용자가 `docker pull app:1.0`을 실행하면 Docker는 현재 host platform에 맞는 manifest를 선택한다.

```text
amd64 Linux host -> linux/amd64 image pull
arm64 Linux host -> linux/arm64 image pull
```

Apple Silicon 개발 환경, x86_64 서버, arm64 서버가 섞여 있으면 이 구조를 알아야 한다.

## build 명령

Buildx에서는 `--platform`으로 대상 platform을 지정한다.

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/kimgunwooo/sample-app:1.0 \
  --push \
  .
```

multi-platform image는 local Docker image store에 단일 image처럼 적재하기보다 registry에 image index와 platform별 manifest를 push하는 방식이 일반적이다. 그래서 `--push`를 같이 쓰는 경우가 많다.

## platform별 build는 cache도 분리해서 봐야 한다

같은 Dockerfile이라도 platform이 달라지면 `FROM`부터 달라질 수 있다.

```dockerfile
FROM eclipse-temurin:17-jre
```

이 base image tag가 multi-platform이면 BuildKit은 대상 platform에 맞는 base manifest를 고른다.

```text
linux/amd64 build -> amd64 base image
linux/arm64 build -> arm64 base image
```

cache key에도 platform이 영향을 준다. 같은 `RUN mvn package`라도 amd64 build 결과와 arm64 build 결과를 같은 cache로 볼 수 없다.

실무에서는 cache ref도 platform별로 나눠서 보는 편이 분석하기 쉽다.

```text
sample-app:buildcache-main-amd64
sample-app:buildcache-main-arm64
```

이렇게 하면 어떤 architecture build가 느린지, 어떤 cache가 깨졌는지 추적하기 쉽다.

## build 방식 3가지

multi-platform build를 처리하는 방식은 크게 세 가지다.

| 방식 | 설명 | 장단점 |
| --- | --- | --- |
| QEMU emulation | 한 host에서 다른 architecture build 실행 | 설정은 쉽지만 compile/dependency install이 느릴 수 있음 |
| native builder | amd64/arm64 builder를 architecture별로 둠 | 빠르지만 builder pool 관리가 필요함 |
| cross-compilation | host와 다른 target binary 생성 | Go는 유리하지만 JVM/Node/Python은 dependency 영향 때문에 복잡할 수 있음 |

작은 개인 프로젝트는 QEMU로 시작해도 된다. 다만 CI 시간이 중요해지면 native builder pool을 고려하는 편이 낫다.

## 정리

Docker build를 빠르게 만들려면 세 가지를 같이 봐야 한다.

1. Dockerfile layer 순서로 cache invalidation 범위를 줄인다.
2. multi-stage build로 runtime image에 필요한 것만 남긴다.
3. multi-platform build에서는 architecture별 cache와 builder 전략을 분리해서 본다.

처음에는 옵션이 많아 보이지만, 결국 질문은 단순하다.

```text
무엇이 자주 바뀌는가?
무엇이 runtime에 필요한가?
어떤 platform에서 실행되는가?
```

이 세 가지를 먼저 정리하면 Dockerfile과 CI build 설정을 훨씬 덜 감으로 다룰 수 있다.
