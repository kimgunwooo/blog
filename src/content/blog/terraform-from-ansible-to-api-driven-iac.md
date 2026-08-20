---
title: 'Terraform은 EC2 생성기가 아니었다: Ansible 사용자 관점의 IaC 입문'
description: 'SSH로 기존 서버를 구성하던 Ansible 경험에서 출발해 Terraform의 provider, state, plan/apply, Docker·Kubernetes·GitOps 소유권 경계를 정리했다.'
category: 'Automation'
pubDate: '2026-07-29T11:54:54+09:00'
createdAt: '2026-07-29T11:54:54+09:00'
showTime: true
tags: ['terraform', 'iac', 'hcl', 'ansible', 'docker', 'kubernetes', 'gitops']
---

Ansible로 Linux 서버의 Docker, 디렉터리, 권한, 환경 파일을 반복 구성하면서도 Terraform은 한동안 "EC2 같은 클라우드 리소스를 코드로 만드는 도구" 정도로만 이해했다. 틀린 말은 아니지만, 왜 Terraform이 필요한지와 Ansible·Kubernetes·Argo CD 사이의 경계를 설명하기에는 부족한 정의였다.

질문은 이어졌다. private cloud나 OpenStack에서도 쓸 수 있는가? Docker container와 Kubernetes Deployment도 Terraform으로 선언할 수 있는가? 가능하다면 Argo CD와 같은 리소스를 동시에 관리해도 되는가?

이 글은 Ansible을 먼저 사용한 입장에서 Terraform을 다시 정리한 입문 기록이다. 아직 Terraform을 실무 환경에 적용했다는 뜻은 아니다. 이어지는 로컬 Docker Provider 실습으로 `plan`, `apply`, state, drift를 직접 확인한다.

## Ansible을 먼저 알면 Terraform을 이렇게 구분할 수 있다

가장 단순한 차이는 **어디에 접속해 무엇을 바꾸는가**다.

- **Ansible**은 이미 존재하는 서버에 SSH 등으로 접속해 OS와 runtime 상태를 맞춘다. 패키지 설치, 디렉터리 생성, 권한 설정, 설정 파일 배치, RKE2 설치 같은 작업이 중심이다.
- **Terraform**은 provider를 통해 대상 플랫폼의 API를 호출해 리소스 수명주기를 관리한다. VM, network, volume, IAM, DNS, Docker container, Kubernetes resource처럼 API로 만들고 읽고 수정하고 삭제할 수 있는 대상을 선언한다.

예를 들어 IDC에서 준비된 Linux 서버를 테넌트 실행 환경으로 바꿀 때는 Ansible이 자연스럽다. 반면 OpenStack이나 AWS처럼 VM, network, security rule을 API로 생성할 수 있는 환경이라면 Terraform이 기반 자원을 만들고, Ansible이 그 서버 내부를 구성하는 흐름이 자연스럽다.

```text
Terraform ──API──> VM · Network · Cluster
                         │
                         └──> Ansible ──> OS · Docker · RKE2 설정

Argo CD ──Git desired state──────────────────> Kubernetes application workload
```

중요한 것은 Terraform과 Ansible이 경쟁 관계가 아니라는 점이다. Terraform은 **인프라 객체의 lifecycle**, Ansible은 **만들어진 서버의 desired state**에 각각 강점이 있다.

## Terraform의 핵심은 HCL보다 state다

Terraform 파일은 HCL(HashiCorp Configuration Language)로 작성한다. HCL은 `resource`, `variable`, `output`, `module` 같은 block을 조합해 "원하는 상태"를 표현하는 언어다.

```hcl
resource "aws_instance" "app" {
  ami           = var.ami_id
  instance_type = "t3.small"
}
```

하지만 이 코드만으로 Terraform이 동작하는 것은 아니다. Terraform은 `state`에 `aws_instance.app`과 실제 클라우드 VM의 identity를 연결해 둔다. 이후 `plan`에서 코드, state, 실제 API 조회 결과를 비교한 뒤 create/update/destroy 후보를 보여주고, `apply`가 승인된 변경을 실행한다.

`plan`은 HCL configuration, Terraform state, Provider API에서 조회한 실제 resource를 함께 비교한다. `apply`는 승인한 변경을 실제 API에 반영하고, 그 결과를 state에 기록한다.

이 때문에 Terraform state는 단순 캐시가 아니다. 협업 환경에서는 state locking과 접근 제어가 필요하고, secret이나 초기 password 같은 민감 값이 들어갈 수 있다. `sensitive = true`는 CLI 출력 일부를 가릴 수 있지만 state 저장 자체를 자동으로 막지는 않는다. local state를 Git에 올리지 않고, 팀 환경에서는 원격 backend와 locking을 쓰는 이유다.

## Provider가 Terraform의 범위를 정한다

Terraform이 AWS 전용 도구가 아닌 이유는 provider 때문이다. Provider는 Terraform이 외부 API와 통신하도록 하는 plugin이며, 어떤 resource를 만들 수 있는지는 provider가 제공하는 schema에 따라 결정된다.

그래서 아래처럼 서로 다른 대상도 같은 `init → plan → apply` 흐름으로 다룰 수 있다.

| Provider 대상 | 관리 예시 | 주의할 점 |
| --- | --- | --- |
| AWS / OpenStack / Naver Cloud | VM, network, volume, load balancer, IAM | provider별 resource schema는 서로 다름 |
| Docker | image, container, network, volume | CI나 Docker Compose와 소유권이 겹치지 않게 설계 |
| Kubernetes | Namespace, RBAC, quota, Deployment, Service, CRD | Argo CD와 같은 workload를 함께 관리하지 않음 |
| Helm | chart release와 values | Argo CD Helm application과 중복 소유하지 않음 |

같은 HCL 문법을 사용한다고 AWS와 OpenStack 코드가 완전히 같아지는 것은 아니다. `aws_instance`와 `openstack_compute_instance_v2`는 resource type과 속성이 다르다. 공통 흐름을 재사용할 수 있다는 뜻이지, cloud 차이를 완전히 숨긴다는 뜻은 아니다.

또한 Docker Provider는 HashiCorp가 직접 관리하는 provider가 아니라 `kreuzwerker/docker` provider를 사용한다. Terraform Registry에는 HashiCorp, 파트너, 커뮤니티가 유지하는 provider가 함께 있다. provider의 유지 주체, 버전 제약, API 호환성도 코드 리뷰 대상이 된다.

## Docker와 Kubernetes까지 선언할 수 있다

Terraform Docker Provider는 image와 container를, Kubernetes Provider는 Deployment·Service 같은 resource와 CRD/custom resource까지 관리할 수 있다. 따라서 "Terraform은 EC2만 만든다"는 이해는 좁다.

```hcl
resource "docker_image" "nginx" {
  name = "nginx:latest"
}

resource "docker_container" "nginx" {
  name  = "terraform-lab-nginx"
  image = docker_image.nginx.image_id
}
```

```hcl
resource "kubernetes_namespace_v1" "lab" {
  metadata {
    name = "terraform-lab"
  }
}
```

여기서 중요한 구분은 **선언 가능성**과 **운영 소유권**이다. Terraform으로 Deployment를 만들 수 있다고 해서 모든 Kubernetes application을 Terraform으로 배포하는 것이 항상 좋은 선택은 아니다.

## Kubernetes와 함께 쓸 때는 리소스 소유권을 나눈다

Argo CD는 Git repository를 application desired state의 source of truth로 삼고, cluster의 live state와 계속 비교해 sync한다. 반면 Terraform은 state를 기준으로 `plan/apply` 시점에 resource lifecycle을 관리한다.

같은 `Deployment`를 Terraform과 Argo CD가 각각 다른 image tag, replica 수, environment variable로 관리하면 충돌한다. Terraform apply 뒤 Argo CD가 Git 기준으로 되돌리거나, Argo CD sync 뒤 Terraform plan이 drift를 감지하는 식이다. field 일부만 나누는 고급 구성도 가능할 수 있지만, 입문 단계와 일반적인 운영 기준에서는 **resource 단위의 단일 소유권**이 가장 안전하다.

현재 RKE2 home cluster처럼 Argo CD가 `home-ops` repository의 application manifest를 관리하는 구조라면, Deployment, Service, Ingress, image digest는 Argo CD에 맡기는 것이 맞다. Terraform을 추가한다면 namespace, RBAC, quota처럼 application과 경계가 명확한 기반 resource부터 실험하는 편이 안전하다.

Terraform으로 RKE2 node join까지 할 수 있느냐는 질문도 같은 기준으로 볼 수 있다. Terraform은 VM을 만들고 `user_data`나 cloud-init 설정을 전달할 수 있다. 하지만 Docker 설치, RKE2 설정, agent join, 재실행 검증은 Ansible이나 cloud-init처럼 OS bootstrap에 맞는 도구가 더 적절하다. Terraform의 `remote-exec` provisioner로 SSH 명령을 실행할 수는 있지만, HashiCorp도 예측하기 어려운 동작과 직접 네트워크·credential 접근 문제 때문에 provisioner를 최후 수단으로 두라고 안내한다.

## 내 환경에서의 현실적인 경계

지금까지 Ansible로 해 온 작업을 기준으로 보면, 다음처럼 역할을 나누는 것이 이해하기 쉽다.

| 단계 | 담당 도구 | 예시 |
| --- | --- | --- |
| 기반 인프라 생성 | Terraform | OpenStack VM, network, volume, security group 또는 managed Kubernetes node group |
| 서버 bootstrap | Ansible | Docker/RKE2 설치, 계정·권한, directory, runtime prerequisite |
| image build와 artifact 생성 | Jenkins / GitHub Actions | build, test, registry push, digest 기록 |
| application deploy | Argo CD | GitOps promotion, manifest sync, rollout 확인 |
| 상태 확인 | OpenTelemetry / Grafana | log, metric, trace, alert 기준 확인 |

이 경계는 조직마다 달라질 수 있다. Terraform이 Helm으로 Argo CD 자체를 설치하고 root Application 하나를 bootstrap하는 구조도 가능하다. 다만 root Application이 관리하는 하위 application resource까지 Terraform이 다시 건드리지는 않아야 한다.

## Docker Provider 실습: 비용 없이 state와 drift 확인하기

Terraform을 처음 공부할 때 곧바로 AWS나 Naver Cloud 계정을 연결하면 IAM, billing, network 설정 때문에 핵심 개념이 흐려질 수 있다. 다음 실습에서는 로컬 Docker만 사용해 아래 흐름을 확인할 예정이다.

1. Terraform Docker Provider로 Nginx image, network, volume, container를 선언한다.
2. `init`, `fmt`, `validate`, `plan`, `apply`의 역할을 분리해 본다.
3. `terraform state list`와 `terraform state show`로 state가 무엇을 기록하는지 확인한다.
4. Docker CLI로 container를 의도적으로 삭제한 뒤, 다음 `plan`에서 drift가 어떻게 나타나는지 확인한다.
5. `destroy`로 lab resource만 정리한다.

이 실습의 목적은 Nginx를 띄우는 것이 아니다. **코드, state, 실제 resource가 서로 다를 때 Terraform이 무엇을 비교하고 어떤 변경을 제안하는지**를 직접 보는 것이다. Docker lab에서 이 흐름을 확인한 뒤, Kubernetes에서는 어느 resource까지 Terraform에 맡기고 어디부터 Argo CD에 맡길지 판단하는 것이 다음 단계다.

## 정리

Terraform은 cloud resource를 코드로 만드는 도구이지만, 본질은 provider API와 state를 이용해 외부 resource lifecycle을 선언적으로 관리하는 도구에 가깝다. Ansible과 비교하면 Terraform은 서버를 만들고 연결하는 쪽, Ansible은 그 서버 내부 상태를 맞추는 쪽에 더 가깝다.

Docker와 Kubernetes resource도 Terraform으로 선언할 수 있다. 그러나 실제 운영에서는 "무엇을 만들 수 있는가"보다 "누가 그 resource의 desired state를 소유하는가"를 먼저 정해야 한다. 현재처럼 Argo CD가 application workload를 GitOps로 관리한다면 Terraform은 기반 인프라와 명확한 cluster foundation에 집중하는 것이 충돌을 줄이는 방향이다.

## 참고 자료

- [HashiCorp Terraform: What is Terraform?](https://developer.hashicorp.com/terraform/intro)
- [Terraform Language](https://developer.hashicorp.com/terraform/language)
- [Terraform State](https://developer.hashicorp.com/terraform/language/state)
- [Manage sensitive data in Terraform](https://developer.hashicorp.com/terraform/language/manage-sensitive-data)
- [Terraform Docker Provider tutorial](https://developer.hashicorp.com/terraform/tutorials/docker-get-started/docker-build)
- [Manage Kubernetes resources with Terraform](https://developer.hashicorp.com/terraform/tutorials/kubernetes/kubernetes-provider)
- [Terraform Provisioners](https://developer.hashicorp.com/terraform/language/provisioners)
- [Argo CD: CI automation and GitOps](https://argo-cd.readthedocs.io/en/stable/user-guide/ci_automation/)
