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

## 이미지 tag

GitHub Actions는 다음 기준으로 이미지를 만든다.

- `main` push: `git-<commit>`
- GitHub Release 발행: Release tag 그대로 사용. 예: `v0.11`
- 수동 `workflow_dispatch`: 입력한 tag 사용. 일회성 이미지 검증 용도

`main` push 또는 Release 발행 후 workflow가 `deploy/k8s/kustomization.yaml`의 `newTag`를 변경하고 같은 저장소의 `main`에 commit한다.

```yaml
images:
  - name: ghcr.io/kimgunwooo/blog
    newTag: v0.11
```

Kustomize는 이 값을 사용해 Deployment의 `image` tag를 최종 manifest에 반영한다. Argo CD는 `home-ops` Application의 source revision을 기준으로 이 manifest를 읽고 sync한다.

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
