---
title: 'Docker BuildKit cache는 왜 Dockerfile 순서에 민감할까'
description: 'build context, LLB graph, cache key 관점에서 Dockerfile 순서가 CI 빌드 시간을 바꾸는 이유를 정리했다.'
category: 'Docker'
pubDate: '2026-07-06'
tags: ['docker', 'buildkit', 'cache', 'dockerfile']
---

처음에는 Jenkins agent마다 build 시간이 달라지는 문제가 Jenkins 설정 문제처럼 보였다. 그런데 들여다보니 핵심은 Docker build cache였다. agent가 바뀌면 local BuildKit cache도 바뀌고, Dockerfile 순서에 따라 cache가 깨지는 범위도 달라졌다.

이 글은 Dockerfile build가 어떤 단위로 cache를 판단하는지 정리한 메모다.

## build context

`docker buildx build .`에서 마지막 `.`이 build context다.

```text
docker buildx build .
                    ^
                    이 디렉터리 파일들이 build context
```

Dockerfile의 `COPY`, `ADD`는 build context 안의 파일만 접근할 수 있다. 그래서 `.dockerignore`가 중요하다.

```text
node_modules
.next
.git
logs
target
```

불필요한 파일이 context에 들어가면 context 전송량이 늘고, `COPY . .`의 checksum 대상도 늘어난다. 결과적으로 cache invalidation 가능성이 커진다.

## BuildKit은 Dockerfile을 graph로 바꾼다

![BuildKit cache flow](/docker-architecture-assets/buildkit-cache-flow.svg)

BuildKit은 Dockerfile을 단순히 위에서 아래로 실행하는 것처럼 보이지만, 내부적으로는 LLB graph로 변환해서 처리한다.

```text
Dockerfile
  -> Dockerfile frontend
  -> LLB graph
  -> BuildKit solver
  -> cache lookup / execute
  -> image export
```

예를 들어 아래 Dockerfile을 보자.

```dockerfile
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
```

이 구조에서는 source만 바뀌면 dependency install 단계는 cache hit가 될 가능성이 높다.

```text
COPY package files  -> cache hit
RUN npm ci          -> cache hit
COPY source         -> cache miss
RUN npm run build   -> cache miss
```

반대로 아래처럼 작성하면 source 파일 하나만 바뀌어도 dependency install까지 다시 실행될 수 있다.

```dockerfile
COPY . .
RUN npm ci
RUN npm run build
```

```text
COPY . .           -> cache miss
RUN npm ci         -> cache miss
RUN npm run build  -> cache miss
```

즉 Dockerfile 순서는 “보기 좋은 순서”가 아니라 cache가 깨지는 범위를 결정하는 구조다.

## cache key는 무엇을 기준으로 만들어질까

BuildKit은 step마다 입력값을 보고 cache key를 만든다. 내부 hash 공식 전체를 외울 필요는 없지만, 어떤 값이 cache에 영향을 주는지는 알아야 한다.

| instruction | cache 판단에 중요한 요소 |
| --- | --- |
| `FROM` | base image reference, resolved digest, platform |
| `COPY`, `ADD` | source file content/checksum, destination, 이전 state |
| `RUN` | command string, 이전 state, env/arg/mount/network 설정 |
| `ENV`, `ARG` | 이후 instruction cache key에 영향 |
| `COPY --from=build` | source stage 결과, path, option |

`RUN apt-get update`처럼 외부 repository 상태가 바뀌는 명령도 Docker가 자동으로 remote 상태를 검사해서 cache를 깨지는 않는다. 의도적으로 갱신하려면 `--no-cache`나 build arg 변경 같은 별도 장치가 필요하다.

## registry cache가 필요한 이유

CI agent가 하나일 때는 local BuildKit cache만으로도 어느 정도 효과가 있다. 문제는 agent가 여러 대일 때다.

```text
build-agent-1 local BuildKit cache 있음
build-agent-2 local BuildKit cache 없음
```

이때 `build-agent-2`에서 build가 걸리면 local cache가 없어서 cold build에 가까워진다. 이 문제를 줄이는 방법이 registry cache다.

```bash
docker buildx build \
  --cache-from type=registry,ref=ghcr.io/kimgunwooo/sample-app:buildcache-main \
  --cache-to type=registry,ref=ghcr.io/kimgunwooo/sample-app:buildcache-main,mode=max \
  --tag ghcr.io/kimgunwooo/sample-app:main \
  --push \
  .
```

`--cache-from`은 registry에 있는 cache metadata를 cache 후보로 사용한다. `--cache-to`는 이번 build 결과의 cache graph를 registry로 export한다.

`mode=max`는 final image에 필요한 layer만이 아니라 intermediate stage cache까지 export한다. Maven, npm, pip dependency stage를 재사용하려면 보통 `mode=max`가 유리하다.

## 주의할 점

registry cache 옵션만 붙였다고 항상 안정적으로 동작하는 것은 아니다.

확인할 것은 아래다.

- Buildx/BuildKit을 쓰는지
- builder driver가 registry cache backend를 지원하는지
- registry cache ref에 push/pull 권한이 있는지
- 실행 image tag와 cache image ref를 분리했는지
- cache export 실패를 로그나 artifact로 확인할 수 있는지

특히 `ignore-error=true`는 cache export가 실패해도 build 자체는 성공시킨다. 배포 실패를 줄이는 데는 도움이 되지만, cache가 실제로 저장되지 않는 문제를 숨길 수 있다.

## 다음 글

다음 글에서는 cache hit뿐 아니라 최종 runtime image를 어떻게 줄일지, multi-stage build와 multi-platform build를 어떻게 이해할지 정리한다.
