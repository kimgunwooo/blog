# Release 운영 규칙

GitHub Release는 단순한 Git tag가 아니라, 운영기록·컨테이너 image·Kubernetes desired state를 연결하는 배포 기준점이다.

## 버전 규칙

운영기록의 버전, Git tag, GitHub Release, GHCR image tag를 같은 문자열로 사용한다.

| 의미 | 예시 | 다음 버전 |
| --- | --- | --- |
| patch: 버그·문서·운영 설정 수정 | `v0.12.1` | `v0.12.2` |
| minor: 호환성을 유지하는 기능 추가 | `v0.13.0` | `v0.14.0` |
| major: 호환성을 깨는 구조 변경·안정화 기준점 | `v1.0.0` | `v2.0.0` |

현재 최신 기준점은 `v0.12.0`이다. `v0.9`, `v0.10`, `v0.11`은 세 자리 SemVer로 전환하기 전의 역사적 운영기록이다.

## 배포 lane

모든 변경을 Release로 만들지 않는다.

| 변경 | workflow | 이미지 tag | GitHub Release | 운영기록 |
| --- | --- | --- | --- | --- |
| `src/content/blog/**`, `public/images/blog/**`만 변경 | `Publish content image` | `sha-<commit>` | 만들지 않음 | 추가하지 않음 |
| 레이아웃·기능·인프라·CI 변경 | `Publish release image` | `vX.Y.Z` | 생성 | 추가 |

콘텐츠 workflow는 허용된 콘텐츠 경로 외의 파일이 같은 push에 포함되면 실패한다. 혼합 변경은 Release lane으로 분리하거나 PR을 나눈다.

두 workflow는 `blog-production-promotion` concurrency group을 공유한다. 둘 중 하나가 `newTag`를 promotion하는 동안 다른 workflow는 기다린다.

## Release 발행 순서

1. 코드와 글을 수정한다.
2. `src/pages/ops-log.astro`에 배포할 버전의 운영기록을 추가한다.
3. PR과 `main` push에서 `npm run build`와 `kubectl kustomize deploy/k8s` 검증을 통과시킨다.
4. 최신 GitHub Release를 기준으로 patch·minor·major 중 하나를 계산한다.
5. 운영기록이 포함된 커밋에 SemVer annotated tag를 만들고 push한다.

   ```bash
   git tag -a v0.12.0 -m "v0.12.0"
   git push origin v0.12.0
   ```

6. `Publish release image` workflow가 tag 형식과 운영기록의 버전 일치를 확인한다.
7. workflow가 tag 커밋에서 multi-platform image `ghcr.io/kimgunwooo/blog:v0.12.0`을 빌드하고 push한다.
8. workflow가 같은 tag의 GitHub Release를 자동으로 만든다.
9. workflow가 `main`의 `deploy/k8s/kustomization.yaml` `newTag`를 `v0.12.0`으로 바꾸고 promotion commit을 push한다.
10. Argo CD가 `home-ops`의 `blog` Application을 통해 변경을 sync한다.
11. Discord에서 `on-deployed`, `on-sync-failed`, `on-health-degraded` 결과를 확인한다.

GitHub Release 생성 단계는 저장소 Actions secret `RELEASE_TOKEN`을 사용한다. GHCR image push와 `main` manifest promotion에는 `GITHUB_TOKEN`을 사용하고, Release API에는 workflow 파일 변경까지 처리할 수 있는 별도 token을 사용한다. token 값은 Git에 저장하지 않는다.

Release workflow는 `release: published` 이벤트를 사용하지 않는다. tag push 하나만 입력으로 사용하므로, workflow가 Release를 자동 생성해도 중복 이미지 빌드가 발생하지 않는다.

## main push와 배포 lane의 차이

| 방식 | 동작 | 운영 배포 |
| --- | --- | --- |
| PR | 사이트 빌드·manifest 렌더링 검증 | 하지 않음 |
| 콘텐츠 경로의 `main` push | 사이트 빌드·manifest 렌더링·SHA image·manifest promotion | Argo CD가 수행 |
| 그 외 `main` push | 사이트 빌드·manifest 렌더링 검증 | 하지 않음 |
| `vX.Y.Z` tag push | Release·GHCR image·manifest promotion 실행 | Argo CD가 수행 |

이렇게 하면 글 수정은 Release 버전을 오염시키지 않으면서 바로 배포할 수 있다. 애플리케이션 기능과 인프라 변경은 여전히 사람이 확인한 SemVer tag를 통해 배포한다.

## Rollback

rollback은 이전에 검증한 Release tag를 다시 desired state에 기록하는 방식이다.

```yaml
images:
  - name: ghcr.io/kimgunwooo/blog
    newTag: v0.11
```

수동으로 클러스터 Deployment를 수정하지 않고 Git 변경으로 되돌리면 Argo CD 상태와 실제 클러스터 상태를 다시 일치시킬 수 있다. 이후에는 rollback도 별도 patch release 또는 명시적인 manifest promotion으로 기록하는 편이 안전하다.
