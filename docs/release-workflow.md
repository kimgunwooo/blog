# Release 운영 규칙

GitHub Release는 단순한 Git tag가 아니라, 운영기록·컨테이너 image·Kubernetes desired state를 연결하는 배포 기준점이다.

## 버전 규칙

운영기록의 버전과 GitHub Release tag를 같은 문자열로 사용한다.

| 운영기록 | GitHub Release | GHCR image |
| --- | --- | --- |
| `v0.9` | `v0.9` | `ghcr.io/kimgunwooo/blog:v0.9` |
| `v0.10` | `v0.10` | `ghcr.io/kimgunwooo/blog:v0.10` |

현재 `0.x`는 블로그 구조와 운영 방식을 계속 바꾸는 단계다.

- `v0.x`: 기능과 운영 구조가 바뀔 수 있는 단계
- `v1.0`: 핵심 작성·배포·댓글·분석 흐름이 안정된 첫 기준점
- 이후 기능 추가: `v1.1`, `v1.2`
- 긴급한 호환성·버그 수정: `v1.0.1`

## Release 발행 순서

1. 코드와 글을 수정한다.
2. `src/pages/ops-log.astro`에 같은 버전의 운영기록을 추가한다.
3. `npm run build`를 통과시킨다.
4. 변경을 `main`에 push한다.
5. GitHub의 **Releases → Draft a new release**에서 같은 tag를 입력한다.
6. 예시: 운영기록이 `v0.11`이면 Release tag도 `v0.11`로 발행한다.
7. `Publish image` workflow가 Release tag의 소스에서 multi-platform image를 빌드한다.
8. image push가 끝나면 workflow가 `deploy/k8s/kustomization.yaml`의 `newTag`를 같은 tag로 변경한다.
9. Argo CD가 `home-ops`의 `blog` Application을 통해 변경을 sync한다.
10. Discord에서 배포 완료 또는 실패 알림을 확인한다.

## 일반 push와 Release의 차이

| 방식 | image tag | 목적 |
| --- | --- | --- |
| `main` push | `git-<commit>` | 일상적인 변경과 빠른 배포 |
| GitHub Release | `v0.x` | 사람이 읽을 수 있는 운영 기준점 |
| 수동 workflow | 입력한 tag | 일회성 빌드·검증 |

Release workflow는 Release event의 tag를 checkout하므로, Release 시점의 코드와 image가 일치한다. manifest 승격 commit은 `main`에 기록되고, Argo CD는 그 desired state를 읽는다.

## Rollback

이 구조에서 rollback은 이전에 검증한 Release tag를 다시 desired state에 기록하는 방식이다.

```yaml
images:
  - name: ghcr.io/kimgunwooo/blog
    newTag: v0.10
```

수동으로 클러스터 Deployment를 수정하지 않고 Git 변경으로 되돌리면, Argo CD 상태와 실제 클러스터 상태를 다시 일치시킬 수 있다.
