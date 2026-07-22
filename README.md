# platform-ops-log

## Purpose

`platform-ops-log` is a self-hosted operations blog for recording how a small platform is built, deployed, observed, and recovered.

The goal is not to replace Velog. The goal is to keep an operator-owned record of work that needs reproducible evidence:

- architecture decisions
- deployment notes
- incident notes
- observability changes
- backup and rollback drills
- infrastructure experiments

Velog remains useful for public summaries and discovery. This site remains useful as a controlled, versioned, runnable artifact.

## Architecture

This project starts as a static Astro blog.

```text
Markdown posts
  -> Astro build
  -> static HTML/CSS/assets in dist/
  -> container or static web server
  -> GitOps deployment
```

The first version is intentionally stateless:

- source content lives in Git
- the built site is generated at deploy time or image build time
- runtime pods only serve static files
- no database is required
- no upload path is required
- no runtime write path is required

That keeps the first operating surface small enough to focus on deploy, uptime, logs, metrics, alerts, and rollback.

## Why Velog + self-hosted blog

Velog and this site serve different jobs.

Velog is the distribution channel:

- public discovery
- short explanations
- polished summaries
- links back to deeper material

This repository and site are the operating record:

- exact Markdown source
- commit history
- deploy history
- configuration and manifests, when added
- evidence that the service is actually running
- notes that can be tied to alerts, dashboards, rollbacks, and incidents

The split keeps public writing readable while preserving the engineering trail needed to reproduce the work.

## Why no PVC at first

A PersistentVolumeClaim is not needed for the first version because the blog is static.

Static output is produced by `npm run build` and served from generated files. After the site is built, the running server does not need to write posts, images, indexes, sessions, uploads, or database rows.

Adding a PVC too early would create storage operations before the application needs storage operations:

- backup scope becomes larger
- restore testing becomes more complex
- volume scheduling can constrain pods
- data ownership becomes less clear
- failure modes increase without a matching product need

PVC becomes reasonable only when the site gains a real runtime state requirement, such as self-hosted uploads, a local search index that must persist, an embedded analytics store, or a CMS/database.

## Local development

Requirements:

- Node.js `>=22.12.0`
- npm

Commands:

```sh
npm install
npm run dev
npm run build
npm run preview
```

Use `npm run dev` while writing locally. Use `npm run build` before deployment to confirm the static output is valid.

## Writing workflow

Posts live in `src/content/blog/*.md`.

Each post needs frontmatter like this:

```md
---
title: 'Docker 이미지와 컨테이너는 어떻게 다른가'
description: '글 목록과 공유 메타에 쓰이는 한 줄 설명'
category: 'Docker'
pubDate: '2026-07-07'
tags: ['docker', 'container', 'image']
---

본문은 일반 Markdown으로 작성한다.
```

Images that should be served publicly can be placed under `public/`.

```md
![Docker architecture](/docker-architecture-assets/docker-architecture.svg)
```

## Deployment overview

The deployment path is GitOps:

1. Write or update Markdown in the repository.
2. Push to `main`.
3. GitHub Actions builds the Astro static site and publishes a GHCR image tagged `git-<commit>`.
4. GitHub Actions updates `deploy/k8s/kustomization.yaml` with the new image tag.
5. Argo CD reconciles the desired image version into the home Kubernetes cluster.
6. Confirm the site through uptime checks, logs, and metrics.

The first deployment should prove the static path only. Later deployments can add observability, alerting, rollback drills, and optional stateful components only when there is a concrete reason.

## Roadmap

See [docs/ops-roadmap.md](docs/ops-roadmap.md) for the operating roadmap.

See [docs/content-workflow.md](docs/content-workflow.md) for the writing and publishing workflow.
