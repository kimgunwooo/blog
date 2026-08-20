---
title: 'Docker 이미지와 컨테이너는 어떻게 다른가'
description: 'docker run을 실행했을 때 image, layer, writable layer, network, process가 어떤 순서로 연결되는지 정리했다.'
category: 'Docker'
pubDate: '2026-07-07'
createdAt: '2026-07-22T13:49:49+09:00'
tags: ['docker', 'container', 'image', 'layer']
---

Jenkins에서 `docker build`, `push`, `deploy`를 다루다 보면 명령어 자체보다 구조를 몰라서 막히는 순간이 많았다. 이미지가 무엇이고, 컨테이너가 무엇이고, 레이어가 왜 캐시에 영향을 주는지 설명하려면 Docker를 조금 더 아래에서 볼 필요가 있었다.

이 글은 Docker build/cache를 정리하기 전의 기본기 메모다.

## 한 줄 요약

Docker는 애플리케이션을 **image**라는 불변 패키지로 만들고, 그 image를 기반으로 **container**라는 격리된 프로세스를 실행한다.

image는 여러 read-only layer로 구성되고, container가 실행되면 그 위에 container 전용 writable layer가 붙는다.

```text
container writable layer
image layer N
image layer N-1
base layer
```

## Docker 전체 구조

![Docker architecture](/docker-architecture-assets/docker-architecture.svg)

Docker를 크게 나누면 아래처럼 볼 수 있다.

| 구성 요소 | 역할 |
| --- | --- |
| Docker CLI | `docker run`, `docker buildx build`, `docker ps` 같은 명령을 실행 |
| Docker Engine / dockerd | image, container, network, volume 같은 Docker object 관리 |
| Buildx | build 요청을 BuildKit에 전달하는 client |
| BuildKit | Dockerfile을 해석하고 build/cache 처리를 수행 |
| containerd | container lifecycle 관리 |
| runc | 실제 container process 생성. namespace/cgroup 격리 적용 |
| Registry | Docker Hub, GHCR, Harbor 같은 image 저장소 |

중요한 점은 CI에서 Jenkins가 image를 직접 만드는 게 아니라는 점이다.

```text
Jenkins pipeline
  -> docker buildx build
    -> Buildx
      -> BuildKit
        -> image build/cache/export
```

Jenkins는 명령을 실행하는 오케스트레이터에 가깝고, Dockerfile 해석과 cache 판단은 BuildKit이 한다.

## docker run 내부 흐름

예를 들어 아래 명령을 실행한다고 하자.

```bash
docker run -d -p 8080:80 --name web nginx:alpine
```

내부 흐름은 대략 이렇다.

1. `nginx:alpine` tag를 registry에서 조회한다.
2. 현재 platform에 맞는 manifest를 선택한다.
3. local에 없는 image layer를 pull한다.
4. read-only image layer 위에 container writable layer를 만든다.
5. container를 Docker network에 붙인다.
6. host `8080` port를 container `80` port로 publish한다.
7. image의 `ENTRYPOINT`, `CMD`를 기준으로 process를 시작한다.

여기서 tag와 digest 차이가 중요하다.

```text
nginx:alpine          사람이 읽기 쉬운 tag. 나중에 다른 image를 가리킬 수 있음.
sha256:...            content 기반 digest. 같은 content를 고정해서 식별.
```

배포에서 digest를 기록하면 “그때 어떤 image가 배포됐는지”를 tag보다 정확히 추적할 수 있다.

## image는 무엇으로 되어 있나

![Docker image structure](/docker-architecture-assets/image-structure.svg)

registry 관점에서 image는 단순한 tar 파일 하나가 아니다.

```text
tag
  -> manifest / image index
    -> config JSON
    -> layer blobs
```

`CMD`, `ENTRYPOINT`, `ENV`, `LABEL`, `EXPOSE` 같은 Dockerfile instruction은 주로 config metadata에 영향을 준다. 반면 `RUN`, `COPY`, `ADD`는 filesystem layer에 직접 영향을 준다.

| Dockerfile instruction | filesystem layer 생성 여부 |
| --- | --- |
| `RUN` | 보통 생성. 명령 실행 후 filesystem diff가 layer가 됨 |
| `COPY` | 생성. build context 파일을 image filesystem에 추가 |
| `ADD` | 생성. local file, remote URL, tar 처리 결과 추가 |
| `CMD` | filesystem layer 없음. config metadata |
| `ENTRYPOINT` | filesystem layer 없음. config metadata |
| `ENV` | config metadata + 이후 build step cache에 영향 |
| `EXPOSE` | config metadata |

그래서 image size와 build cache를 볼 때는 `RUN`, `COPY`, `ADD`를 먼저 본다.

## container writable layer

Container가 실행될 때 image layer는 read-only로 공유되고, container마다 writable layer가 별도로 붙는다.

```text
같은 image에서 container 10개 실행
  -> image layer는 공유
  -> container별 writable layer만 별도 생성
```

container 안에서 파일을 만들거나 수정하면 writable layer에 기록된다. container를 삭제하면 이 writable layer도 사라진다. 그래서 DB 데이터처럼 남아야 하는 값은 volume이나 bind mount로 빼야 한다.

## 다음 글

다음 글에서는 이 layer 구조가 Docker build cache와 어떻게 연결되는지 본다. 특히 `COPY . .`를 Dockerfile 앞쪽에 두면 왜 source 파일 하나만 바뀌어도 dependency install cache가 깨지는지 정리한다.
