# 배포 구조

이 저장소는 정적 Astro 블로그를 Docker image로 만들고, GHCR과 Argo CD를 통해 홈 Kubernetes에 배포한다.

## 현재 리소스

- 애플리케이션: `blog`
- 이미지: `ghcr.io/kimgunwooo/blog:<tag>`
- 컨테이너 포트: `4321`
- Kubernetes namespace: `blog`
- Argo CD Application: `blog`
- 애플리케이션 manifest 경로: `deploy/k8s`
- 중앙 Argo CD 관리 저장소: [home-ops](https://github.com/kimgunwooo/home-ops)

이 저장소는 애플리케이션 코드와 `deploy/k8s` 리소스를 관리한다. Argo CD Application 자체와 클러스터 공통 구성은 `home-ops`가 관리하므로 이 저장소에서 Application을 직접 apply하지 않는다.

## 로컬 검증

```bash
npm ci
npm run build
docker build -t ghcr.io/kimgunwooo/blog:local .
docker run --rm -p 4321:4321 ghcr.io/kimgunwooo/blog:local
curl -fsS http://127.0.0.1:4321/
kubectl kustomize deploy/k8s
```

## 배포 lane

배포는 콘텐츠 배포와 Release 배포로 나뉜다.

### 콘텐츠 배포

`src/content/blog/**` 또는 `public/images/blog/**`만 변경한 `main` push는 `Publish content image` workflow를 실행한다. 이 workflow는 다음 SHA 기반 이미지를 만든다.

```text
ghcr.io/kimgunwooo/blog:sha-79d3b8a
```

GitHub Release와 `ops-log.astro` 버전 기록은 만들지 않는다. 대신 `newTag`를 SHA tag로 바꾸는 promotion commit을 만들고 Argo CD가 sync한다.

콘텐츠 workflow는 허용 경로 외의 파일이 함께 바뀌면 실패한다. 레이아웃·컴포넌트·Kubernetes·CI 변경은 SemVer Release lane으로 보내야 한다.

### Release 배포

GitHub Actions는 `vX.Y.Z` tag push에서 Release 이미지를 만든다. 예를 들어 `v0.12.0` tag를 push하면 다음 이미지가 생성된다.

```text
ghcr.io/kimgunwooo/blog:v0.12.0
```

PR과 `main` push에서는 사이트 빌드와 manifest 렌더링만 검증한다. Release workflow는 tag 커밋의 코드와 운영기록 버전을 확인한 뒤, 같은 tag로 이미지를 push하고 GitHub Release를 자동 생성한다.

그 다음 workflow가 `deploy/k8s/kustomization.yaml`의 `newTag`를 변경하고 같은 저장소의 `main`에 promotion commit을 만든다.

```yaml
images:
  - name: ghcr.io/kimgunwooo/blog
    newTag: v0.12.0
```

Kustomize는 이 값을 사용해 Deployment의 `image` tag를 최종 manifest에 반영한다. Argo CD는 `home-ops` Application의 source revision을 기준으로 이 manifest를 읽고 sync한다.

두 workflow는 같은 `blog-production-promotion` concurrency group을 사용한다. 콘텐츠 promotion과 Release promotion이 동시에 `newTag`를 수정하지 않도록 한 번에 하나만 실행한다.

## Argo CD 확인

Application은 `home-ops`에서 관리한다. 배포 후에는 다음 순서로 확인한다.

```bash
kubectl --server=https://100.125.75.80:6443 -n argocd get applications.argoproj.io blog
kubectl --server=https://100.125.75.80:6443 -n blog get deploy,svc,pods
kubectl --server=https://100.125.75.80:6443 -n blog wait --for=condition=available deployment/blog --timeout=120s
```

Argo CD 상태가 `Synced / Healthy`가 되면 Discord `on-deployed` 알림을 확인한다. sync 실패나 health degraded 상태는 각각 별도 Discord 알림으로 확인한다.

## Cloudflare Tunnel

Cloudflare Tunnel의 public hostname은 다음 Kubernetes Service를 가리킨다.

- Public hostname: `blog.kwl4b.com`
- Service type: `HTTP`
- Service URL: `blog.blog.svc.cluster.local:4321`

외부 경로가 연결된 뒤 다음 명령으로 최종 경로를 확인한다.

```bash
curl -fsS https://blog.kwl4b.com/
```
