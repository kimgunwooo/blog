---
title: 'GitLab CI와 GitHub Actions로 ECS 배포 파이프라인을 구성해본 기록'
description: 'Spring Boot 애플리케이션을 ECR에 push하고 ECS Service를 갱신하는 흐름을 GitLab CI와 GitHub Actions 기준으로 비교했다.'
category: 'Cloud'
pubDate: '2024-08-09'
updatedDate: '2026-07-23'
tags: ['aws', 'ecs', 'ecr', 'gitlab-ci', 'github-actions', 'cicd']
---

GitHub Actions와 S3, CodeDeploy를 써본 뒤에는 container image를 기준으로 배포하는 흐름이 궁금했다. 작은 프로젝트에서는 DockerHub에 이미지를 올려 직접 배포하기도 했지만, AWS 환경에서는 ECR, ECS task definition, ECS service update의 경계를 따로 봐야 했다.

이 글은 GitLab CI와 GitHub Actions를 비교하면서 ECS/ECR 기반 container 배포 파이프라인에서 어떤 책임을 나눠야 하는지 정리한 기록이다.

## 목표

목표는 Spring Boot 애플리케이션을 container image로 만들고, ECR에 push한 뒤 ECS Service를 새 image로 갱신하는 것이었다.

```text
source push
  -> jar build
  -> docker image build
  -> ECR push
  -> ECS service update
  -> load balancer로 확인
```

배포 대상은 ECS Fargate에 가깝게 잡았다. EC2 instance를 직접 운영하기보다, task definition과 service를 중심으로 컨테이너를 실행하는 구조를 확인하는 것이 목적이었다.

## ECS 구성 요소

ECS를 처음 볼 때는 이름이 헷갈린다. 실습하면서 아래처럼 정리했다.

| 구성 요소 | 역할 |
| --- | --- |
| ECR | Docker image 저장소 |
| ECS Cluster | task와 service가 속하는 논리적 실행 공간 |
| Task Definition | 어떤 image, port, env, resource로 container를 실행할지 정의 |
| Task | task definition을 바탕으로 실제 실행되는 단위 |
| Service | 원하는 task 개수를 유지하고 새 배포를 반영하는 단위 |
| Load Balancer | 외부 요청을 ECS task로 전달 |

파이프라인이 직접 다루는 핵심은 ECR image와 ECS service update다.

## GitLab CI로 구성한 흐름

GitLab CI에서는 세 단계로 나눴다.

```yaml
stages:
  - build jar
  - build and push docker image
  - deploy
```

각 단계의 책임은 명확했다.

| 단계 | 책임 |
| --- | --- |
| build jar | Gradle로 Spring Boot jar 생성 |
| build and push docker image | Docker image build, ECR login, image push |
| deploy | ECS service를 새 task/image로 갱신 |

실습에서는 GitLab runner에서 AWS CLI를 설치하고, AWS access key와 secret key를 환경 변수로 주입했다. 이후 ECR login, docker build/push, `aws ecs update-service`를 실행했다.

```bash
aws ecr get-login-password --region ap-northeast-2 \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker build -t "$IMAGE" .
docker push "$IMAGE"

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --force-new-deployment
```

당시에는 image tag를 `latest`, `develop`처럼 branch에 가깝게 두는 실습을 했다. 지금 다시 본다면 commit SHA 기반 tag를 기본으로 두고, 사람이 읽는 tag는 보조로 남길 것이다.

## GitHub Actions로 구성한 흐름

GitHub Actions에서는 AWS가 제공하는 action 조합을 사용했다.

```text
checkout
  -> setup java
  -> gradle build
  -> configure aws credentials
  -> ECR login
  -> docker build/push
  -> render task definition
  -> deploy task definition
```

GitHub Actions의 장점은 ECS 배포용 action이 이미 잘 나뉘어 있다는 점이었다.

| Action | 역할 |
| --- | --- |
| `aws-actions/configure-aws-credentials` | AWS 인증 설정 |
| `aws-actions/amazon-ecr-login` | ECR login |
| `aws-actions/amazon-ecs-render-task-definition` | task definition의 image 치환 |
| `aws-actions/amazon-ecs-deploy-task-definition` | ECS service 배포 |

GitLab CI에서는 shell script로 직접 엮은 부분이 많았고, GitHub Actions에서는 ECS task definition 갱신이 더 명시적으로 보였다.

## 비교하면서 남은 기준

두 도구 모두 ECS 배포는 가능했다. 차이는 구현 표면이었다.

| 항목 | GitLab CI | GitHub Actions |
| --- | --- | --- |
| 저장소 통합 | GitLab 프로젝트와 자연스럽게 연결 | GitHub 저장소와 자연스럽게 연결 |
| ECS 배포 | AWS CLI 명령을 직접 조합 | ECS 전용 action 사용 가능 |
| 설정 가시성 | 스크립트 중심 | step/action 중심 |
| 익숙함 | GitLab runner 설정을 같이 봐야 함 | GitHub marketplace 예제가 많음 |

개인 프로젝트나 GitHub 중심 repo라면 GitHub Actions가 더 빠르게 붙는다. GitLab을 이미 쓰고 있고 runner 운영까지 포함한다면 GitLab CI도 충분하다.

## 트러블슈팅

원문에서 겪은 문제는 GitLab runner 상태와 branch 이름이었다.

처음에는 job이 보이지 않거나 pending 상태로 남았다. Shared Runner 설정과 branch 조건이 맞지 않아서 생긴 문제였다. `main`에 맞춘 rule을 두고 `master`에 push하면 의도한 pipeline이 돌지 않는다.

이 문제는 사소해 보이지만 운영 기준으로는 중요하다.

```text
trigger branch
runner 상태
environment secret
AWS permission
task definition revision
service deployment status
```

이 중 하나라도 틀리면 “배포 파이프라인 실패”로만 보인다. 그래서 pipeline 로그에서 어느 단계가 실패했는지 나눠서 볼 수 있어야 한다.

## 지금 다시 구성한다면

실습 당시에는 AWS access key를 CI secret으로 넣었다. 지금 다시 구성한다면 OIDC 기반으로 AWS role을 assume하는 방식을 먼저 볼 것이다. 장기 access key를 CI에 저장하는 방식은 관리 부담이 크다.

또한 image tag는 `latest`보다 commit SHA를 우선으로 둘 것이다.

```text
app:git-<commit-sha>
app:main
```

배포 후에는 ECS service stability만 보는 것이 아니라, 최소한 아래도 확인한다.

- 새 task가 running 상태인지
- old task가 정상 drain 됐는지
- load balancer target health가 정상인지
- application health endpoint가 정상인지
- rollback 가능한 이전 task definition revision이 남아 있는지

## 정리

ECS 배포 파이프라인의 핵심은 CI 도구 자체가 아니었다.

```text
빌드 산출물은 무엇인가?
image tag는 어떻게 추적할 것인가?
task definition은 어떻게 갱신할 것인가?
배포 성공은 무엇으로 판단할 것인가?
실패 시 어디까지 되돌릴 수 있는가?
```

GitLab CI든 GitHub Actions든 이 질문에 답할 수 있어야 배포 파이프라인이 된다.

원문: [GitLab CI/CD, Amazon ECS](https://velog.io/@kimgunwooo/TIL-GitLab-CICD-Amazon-ECS)
