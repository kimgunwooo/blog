# Deploy skeleton

This repo is prepared for GHCR plus Argo CD GitOps deployment to the home RKE2 cluster.

## Runtime

- App: `platform-ops-log`
- Image: `ghcr.io/kimgunwooo/platform-ops-log:<tag>`
- Container port: `4321`
- Kubernetes namespace: `platform-ops-log`
- Argo CD application namespace: `argocd`
- Argo source path: `deploy/k8s`
- Account boundary: only the personal GitHub/GHCR account `kimgunwooo` is in scope.

## Local verification

```bash
npm ci
npm run build
docker build -t ghcr.io/kimgunwooo/platform-ops-log:local .
docker run --rm -p 4321:4321 ghcr.io/kimgunwooo/platform-ops-log:local
curl -fsS http://127.0.0.1:4321/
kubectl kustomize deploy/k8s
kubectl kustomize deploy/argocd
```

Stop the local container with `Ctrl-C`.

## Image tags

The GitHub Actions workflow publishes on:

- `main` push with paths that affect the site or Kubernetes manifests
- manual `workflow_dispatch` with an explicit `image_tag`, only for one-off image publishing

On `main` push, the workflow publishes an image tagged `git-<commit>` and commits the same tag back into `deploy/k8s/kustomization.yaml`.

Manual dispatch does not update the GitOps manifest. If you use it, set the same tag in `deploy/k8s/kustomization.yaml` yourself:

```yaml
images:
  - name: ghcr.io/kimgunwooo/platform-ops-log
    newTag: git-<commit>
```

## Argo apply checklist

Do not apply the Argo application until these are true:

- The repo exists at `https://github.com/kimgunwooo/platform-ops-log.git`.
- The commit containing `deploy/k8s` has been pushed.
- The GHCR image tag in `deploy/k8s/kustomization.yaml` has been published for `linux/amd64` and `linux/arm64`.
- If the repo is private, Argo CD has read access to the repo.
- If the GHCR package is private, create an image pull secret in namespace `platform-ops-log` and add `imagePullSecrets` to the Deployment before sync.
- `kubectl kustomize deploy/k8s` renders cleanly.
- `kubectl kustomize deploy/argocd` renders cleanly.
- Cloudflare Tunnel public hostname will be configured manually after cluster deploy.

Apply only after the checklist passes:

```bash
kubectl --server=https://100.125.75.80:6443 apply -k deploy/argocd
```

Argo CD is configured with automated sync. Verify:

```bash
kubectl --server=https://100.125.75.80:6443 -n argocd get applications.argoproj.io platform-ops-log
kubectl --server=https://100.125.75.80:6443 -n platform-ops-log get deploy,svc,pods
kubectl --server=https://100.125.75.80:6443 -n platform-ops-log wait --for=condition=available deployment/platform-ops-log --timeout=120s
```

## Cloudflare Tunnel

Configure this manually in Cloudflare Zero Trust:

- Public hostname: `blog.kwl4b.com`
- Service type: `HTTP`
- Service URL: `platform-ops-log.platform-ops-log.svc.cluster.local:4321`

After DNS and tunnel routing are active:

```bash
curl -fsS https://blog.kwl4b.com/
```
