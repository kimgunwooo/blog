# Operations Roadmap

This roadmap keeps the first version small, then adds operational depth only when each layer has something concrete to observe or protect.

## v0 static blog

Goal: publish a stateless operations blog.

Scope:

- Astro static build
- Markdown posts stored in Git
- static assets served with the site
- no database
- no PVC
- no runtime uploads

Success criteria:

- `npm run build` produces a deployable static site
- the running service can be replaced without data loss
- all content can be restored from Git

## GitOps deploy

Goal: make deployment reproducible from repository state.

Scope:

- build artifact or container image for the static site
- Kubernetes manifests or Helm/Kustomize layer, when needed
- GitOps controller reconciles the desired version
- deployment history tied to Git commits

Success criteria:

- a commit identifies what is deployed
- rollback can target a previous known-good version
- manual cluster changes are not required for normal publishing

## logs, metrics, alerts

Goal: see whether the service is healthy and whether deploys changed behavior.

Scope:

- access logs from the static web server or ingress
- basic request metrics
- error rate and latency signals
- build and deploy failure visibility
- alerts for user-visible failure, not noisy internals

Success criteria:

- a failed deploy is visible
- elevated 4xx/5xx responses are visible
- traffic and latency trends are visible
- alerts point to a concrete operator action

## uptime/synthetic check

Goal: verify the site from outside the pod.

Scope:

- homepage availability check
- representative post URL check
- RSS or sitemap check if used for publishing
- TLS and ingress path validation

Success criteria:

- broken routing is caught
- expired or invalid TLS is caught
- static build regressions are caught after deployment

## backup/rollback

Goal: prove recovery before adding state.

Scope:

- Git is the source backup for content
- container registry or artifact store keeps deployable versions
- GitOps history identifies previous releases
- rollback drill documents exact steps and time to recover

Success criteria:

- content can be recovered from Git
- site can return to a previous artifact
- rollback procedure is written and tested
- recovery does not depend on undocumented local state

## optional search/analytics/PVC only when needed

Goal: add state only when a feature justifies the operational cost.

Possible additions:

- static search index generated at build time: still no PVC
- hosted analytics: no local PVC
- self-hosted analytics: may need database or volume
- local search service with persistent index: may need PVC
- CMS or uploads: likely needs database, object storage, or PVC

Decision rule:

Use stateless options first. Add PVC only when runtime data must survive pod replacement and cannot be rebuilt from Git, build artifacts, or an external managed service.
