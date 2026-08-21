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

PR과 `main` push는 항상 검증을 수행합니다. 운영 배포는 변경 성격에 따라 콘텐츠 배포와 Release 배포로 나뉩니다.

### 콘텐츠 배포

`src/content/blog/**` 또는 `public/images/blog/**`만 변경한 경우입니다.

1. PR에서 Astro 정적 사이트와 Kubernetes manifest를 검증합니다.
2. `main` merge 후 `Publish content image` workflow가 SHA 기반 이미지를 만듭니다.
3. `ghcr.io/kimgunwooo/blog:sha-<commit>`을 GHCR에 push합니다.
4. `deploy/k8s/kustomization.yaml`의 `newTag`를 해당 SHA tag로 바꿉니다.
5. Argo CD가 `home-ops`에서 관리하는 Application을 통해 `blog` namespace에 sync합니다.

콘텐츠 배포는 GitHub Release나 운영기록 버전을 만들지 않습니다.

### Release 배포

레이아웃·기능·인프라·CI 변경입니다.

1. 배포할 변경과 같은 커밋에 `src/pages/ops-log.astro`의 버전 기록을 추가합니다.
2. 준비된 커밋에 `v0.13.0` 같은 annotated tag를 만들고 push합니다.
3. GitHub Actions가 tag와 운영기록 버전을 확인한 뒤 multi-platform image를 같은 tag로 GHCR에 push합니다.
4. workflow가 같은 tag의 GitHub Release를 자동으로 만듭니다.
5. workflow가 `newTag`를 Release tag로 바꾸고 `main`에 promotion commit을 남깁니다.
6. Argo CD가 변경을 sync합니다.

Release와 콘텐츠 배포 모두 Argo CD 결과를 Discord로 알립니다. 알림에는 `콘텐츠 배포` 또는 `Release 배포`가 표시됩니다.

## Release와 운영 기록

운영 기록과 GitHub Release는 Release 배포에서만 같은 SemVer 버전 문자열을 사용합니다.

```text
운영기록 v0.12.0  <->  GitHub Release v0.12.0  <->  GHCR image :v0.12.0
```

버전은 최신 GitHub Release를 기준으로 올립니다.

- patch: `v0.12.0` → `v0.12.1` — 버그, 문서, 운영 설정 수정
- minor: `v0.12.0` → `v0.13.0` — 기존 호환성을 유지하는 기능 추가
- major: `v0.12.0` → `v1.0.0` — 호환성을 깨는 구조 변경 또는 안정화 기준점

Release 배포는 다음처럼 tag를 push하면 나머지는 workflow가 진행합니다.

```sh
git tag -a v0.12.0 -m "v0.12.0"
git push origin v0.12.0
```

`v0.9`, `v0.10`, `v0.11`은 이 규칙으로 전환하기 전의 운영기록이며, `v0.12.0`부터 세 자리 SemVer를 사용합니다.

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
