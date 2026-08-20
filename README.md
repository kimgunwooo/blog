# DevOps 여정기

[![Blog](https://img.shields.io/badge/blog-blog.kwl4b.com-0f172a?logo=astro&logoColor=white)](https://blog.kwl4b.com)
[![Publish image](https://github.com/kimgunwooo/blog/actions/workflows/publish.yml/badge.svg?branch=main)](https://github.com/kimgunwooo/blog/actions/workflows/publish.yml)
[![Latest Release](https://img.shields.io/github/v/release/kimgunwooo/blog?display_name=tag&sort=semver)](https://github.com/kimgunwooo/blog/releases)

운영 문제를 계측하고, 재현하고, 다시 설명할 수 있을 때까지 기록하는 기술 블로그입니다.

블로그는 [blog.kwl4b.com](https://blog.kwl4b.com)에서 볼 수 있습니다. 이 저장소에는 글의 원문뿐 아니라 블로그 자체를 운영하는 코드, Kubernetes manifest, 배포 workflow, 운영 문서를 함께 보관합니다.

## 이 저장소에서 확인할 수 있는 것

- Docker 이미지와 컨테이너 동작
- Kubernetes 네트워크, 배포, 장애 복구
- GitHub Actions, GHCR, Argo CD 기반 GitOps
- OpenTelemetry, Prometheus, Grafana, Loki 관측성
- DB 변경 관리와 운영 자동화
- 홈 Kubernetes에서 실제로 확인한 문제와 판단 과정

정답만 옮겨 적기보다, 무엇이 헷갈렸고 어떤 가설을 세웠으며 어떤 결과를 확인했는지를 남기는 것을 목표로 합니다.

## 블로그와 저장소의 역할

| 공간 | 역할 |
| --- | --- |
| [블로그](https://blog.kwl4b.com) | 읽기 쉬운 설명과 실제 운영 기록 |
| [GitHub 저장소](https://github.com/kimgunwooo/blog) | Markdown 원문, 코드, manifest, workflow, 변경 이력 |
| [운영 기록](https://blog.kwl4b.com/ops-log/) | 블로그 기능과 운영 상태의 버전별 기록 |
| [GitHub Releases](https://github.com/kimgunwooo/blog/releases) | 배포 가능한 버전과 릴리스 시점의 스냅샷 |

## 구성

```text
Markdown 글
  -> Astro + Pagefind build
  -> 정적 HTML/CSS/asset
  -> Docker multi-platform image
  -> GHCR
  -> home-ops의 Argo CD Application
  -> home Kubernetes의 blog namespace
  -> Cloudflare Tunnel
  -> https://blog.kwl4b.com
```

블로그 저장소는 애플리케이션 코드와 `deploy/k8s` manifest를 소유합니다. Argo CD Application과 클러스터 공통 설정은 [home-ops](https://github.com/kimgunwooo/home-ops) 저장소에서 중앙 관리합니다.

## 디렉터리

```text
src/content/blog/       글 원문
src/pages/              홈, 글 목록, 운영 기록, 정적 페이지
src/components/         Header, Footer, 카드, 공통 head
src/layouts/            글 상세 레이아웃과 Mermaid/Giscus 처리
public/                 공개 이미지와 정적 asset
deploy/k8s/             blog Namespace, Deployment, Service, Kustomize
.github/workflows/      이미지 빌드·배포와 댓글 Discord 알림
docs/                   작성·배포·Release 운영 문서
Dockerfile              정적 사이트 runtime image
```

## 배포 흐름

`main`에 변경이 들어오면 GitHub Actions가 다음 작업을 수행합니다.

1. Astro 정적 사이트를 빌드합니다.
2. `linux/amd64`, `linux/arm64` 이미지를 GHCR에 push합니다.
3. 이미지 tag를 `deploy/k8s/kustomization.yaml`에 기록합니다.
4. Argo CD가 `home-ops`에서 관리하는 Application을 통해 desired state를 읽습니다.
5. Argo CD가 `blog` namespace에 Deployment와 Service를 sync합니다.
6. 배포 성공·실패·health 상태를 Discord로 알립니다.

일반 push는 `git-<commit>` 이미지를 사용합니다. 정식 버전은 GitHub Release tag를 이미지 tag로 사용합니다.

## Release와 운영 기록

운영 기록과 GitHub Release는 같은 버전 문자열을 사용합니다.

```text
운영기록 v0.11  <->  GitHub Release v0.11  <->  GHCR image :v0.11
```

Release를 만들 때는 다음 순서를 따릅니다.

1. 코드 변경과 `src/pages/ops-log.astro` 운영기록을 함께 수정합니다.
2. `npm run build`로 정적 빌드를 확인합니다.
3. `main`에 변경을 push합니다.
4. GitHub에서 운영기록과 같은 이름의 Release를 발행합니다. 예: `v0.11`
5. Release workflow가 해당 tag의 이미지를 GHCR에 push합니다.
6. workflow가 `deploy/k8s/kustomization.yaml`의 `newTag`를 같은 Release tag로 승격합니다.
7. Argo CD sync와 Discord 알림으로 실제 배포 결과를 확인합니다.

세부 규칙은 [docs/release-workflow.md](docs/release-workflow.md)에 정리했습니다.

`v1.0`은 단순히 기록 개수가 늘었을 때가 아니라, 글 작성·배포·댓글·분석·운영 기록의 기본 흐름이 안정되고 큰 구조 변경 계획이 없을 때 올립니다.

## 로컬 실행

요구 사항: Node.js `>=22.12.0`, npm

```sh
npm install
npm run dev
```

검증용 정적 빌드:

```sh
npm run build
```

글은 `src/content/blog/*.md`에 작성합니다. 글에 사용할 공개 이미지는 `public/` 아래에 두고 `/images/...` 경로로 참조합니다.

## 문서

- [작성 흐름](docs/content-workflow.md)
- [배포 구조](docs/deploy.md)
- [Release 운영 규칙](docs/release-workflow.md)
- [운영 로드맵](docs/ops-roadmap.md)

## 링크

- 블로그: https://blog.kwl4b.com
- 운영 기록: https://blog.kwl4b.com/ops-log/
- GitHub: https://github.com/kimgunwooo/blog
