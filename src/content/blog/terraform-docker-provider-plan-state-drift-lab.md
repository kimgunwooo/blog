---
title: 'Terraform Docker Provider 실습: plan, state, drift를 로컬에서 확인하기'
description: 'HashiCorp Docker Provider 튜토리얼 흐름을 따라 Nginx container를 선언하고, Colima socket 설정, state 확인, Docker CLI로 만든 drift 복구, destroy까지 검증했다.'
category: 'Automation'
pubDate: '2026-07-29T14:19:40+09:00'
createdAt: '2026-07-29T14:19:40+09:00'
showTime: true
tags: ['terraform', 'docker', 'iac', 'state', 'drift', 'colima']
---

Terraform 입문에서 Docker를 먼저 사용하는 이유는 Nginx 자체를 배우기 위해서가 아니다. cloud billing, IAM, VPC 같은 변수를 잠시 빼고도 **HCL 선언, Provider API, state, plan, apply, drift, destroy**라는 Terraform의 핵심 흐름을 한 번에 확인할 수 있기 때문이다.

이 글은 [HashiCorp Docker Provider 튜토리얼](https://developer.hashicorp.com/terraform/tutorials/docker-get-started/docker-build)의 흐름을 따라, 로컬 Docker에서 Nginx image·network·container를 선언한 실습 기록이다. Docker CLI가 Colima context를 사용하는 환경에서 Provider endpoint를 따로 확인해야 했던 과정도 함께 남긴다.

> 이 실습은 별도 bridge network와 `terraform-docker-lab-nginx` container만 만든다. 기존 container, RKE2 cluster, Argo CD application은 건드리지 않는다.

## 왜 Docker Provider를 선택했나

처음 Terraform을 익힐 때 AWS나 OpenStack을 바로 선택하면 Provider 인증, 과금, network 설계, cleanup까지 동시에 판단해야 한다. 물론 실제 cloud IaC에는 필요한 과정이지만, 이번 실습의 목표는 cloud resource 설계가 아니라 **Terraform이 선언과 실제 API 상태를 어떻게 연결하는지** 확인하는 것이었다.

Docker Provider를 선택한 기준은 세 가지였다.

- **비용과 정리 부담이 작다.** 기존 로컬 Docker daemon만 사용하고, `destroy`로 image·network·container 세 resource를 바로 정리할 수 있다.
- **핵심 흐름이 그대로 보인다.** HCL, Provider plugin, dependency graph, state, plan, apply, refresh, drift는 cloud Provider를 쓸 때와 같은 Terraform 흐름으로 동작한다.
- **검증 범위를 통제할 수 있다.** 기존 서비스와 분리한 network와 이름, host port를 사용해 실습 대상만 확인하고 되돌릴 수 있다.

따라서 이 글은 "Docker를 Terraform으로 운영하는 방법"보다, 이후 AWS·OpenStack·Kubernetes Provider를 다룰 때도 공통으로 적용할 **plan과 state를 읽는 기준**을 만드는 실습이다. Provider가 호출하는 대상 API와 관리하는 resource만 달라질 뿐, 선언-비교-적용-정리의 기본 흐름은 같다.

## 실습에서 확인할 흐름

```text
HCL 작성
  → init: Provider 설치와 lock file 생성
  → fmt / validate: 코드 정리와 정적 검증
  → plan: 코드 · state · Docker API 비교
  → apply: image · network · container 생성
  → Docker CLI 삭제: 실제 resource에만 drift 발생
  → plan / apply: 누락된 container만 복구
  → destroy: Terraform이 관리한 resource만 정리
```

## 0. 사전 확인: Terraform CLI와 Docker endpoint

실습 디렉터리로 이동한다. 이 환경에서는 HashiCorp 공식 배포본 Terraform `v1.15.8`을 lab의 `bin/terraform`에만 두었다. 시스템 전역 설치가 아니라 실습 디렉터리 안의 CLI를 쓰는 방식이다.

```bash
cd /Users/kimgunwoo/Documents/toy/terraform-docker-lab

export PATH="$PWD/bin:$PATH"
terraform version
docker version --format 'server={{.Server.Version}}'
```

다음으로 Terraform Provider가 접근할 Docker endpoint를 정한다.

```bash
docker context show
docker context inspect "$(docker context show)" --format '{{.Endpoints.docker.Host}}'

export DOCKER_HOST="$(docker context inspect "$(docker context show)" --format '{{.Endpoints.docker.Host}}')"
echo "$DOCKER_HOST"
```

현재 Mac은 `colima` context를 사용했고, socket은 `unix:///Users/<user>/.colima/default/docker.sock`였다. 처음에는 Docker Provider가 기본값인 `/var/run/docker.sock`로 연결을 시도해 `Cannot connect to the Docker daemon` 오류가 났다. Docker CLI의 context와 Provider의 기본 endpoint가 항상 자동으로 일치한다고 가정하면 안 된다는 것을 이 단계에서 확인했다.

아래 명령으로 실습 대상 이름이나 port가 이미 사용 중이지 않은지도 확인한다.

```bash
docker ps -a --filter name=terraform-docker-lab-nginx
docker network ls --filter name=terraform-docker-lab
lsof -nP -iTCP:18080 -sTCP:LISTEN
```

마지막 명령은 아무 출력 없이 종료되어도 정상이다. 이미 18080 port를 다른 서비스가 쓰고 있다면 `main.tf`의 `external` port를 비어 있는 값으로 바꾼다.

## 1. HCL로 Docker resource를 선언한다

`main.tf`에는 Docker Provider, 전용 bridge network, Nginx image, container를 선언한다.

```hcl
terraform {
  required_version = "~> 1.15.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.2"
    }
  }
}

provider "docker" {}

resource "docker_network" "lab" {
  name   = "terraform-docker-lab"
  driver = "bridge"
}

resource "docker_image" "nginx" {
  name         = "nginx:1.27-alpine"
  keep_locally = false
}

resource "docker_container" "nginx" {
  name    = "terraform-docker-lab-nginx"
  image   = docker_image.nginx.image_id
  restart = "no"

  networks_advanced {
    name = docker_network.lab.name
  }

  ports {
    internal = 80
    external = 18080
  }
}
```

여기서 Terraform이 추론하는 dependency는 두 가지다.

- `docker_container.nginx`는 `docker_image.nginx.image_id`를 참조하므로 image가 준비된 뒤 생성된다.
- `networks_advanced`가 `docker_network.lab.name`을 참조하므로 network가 준비된 뒤 container가 생성된다.

`depends_on`을 직접 쓰지 않아도 reference를 통해 dependency graph가 만들어진다. Provider는 `kreuzwerker/docker`이며, Terraform CLI 자체와 Provider의 유지 주체·버전은 별도로 확인해야 한다.

## 2. init, fmt, validate를 순서대로 실행한다

```bash
terraform init
terraform fmt -check
terraform validate
```

![Terraform init 실행 결과. dependency lock file에 고정된 kreuzwerker/docker v4.5.0을 재사용하고 초기화를 완료했다.](/images/blog/terraform-docker-provider-plan-state-drift-lab/terraform-init.png)

![Terraform validate 실행 결과. HCL configuration이 유효하다고 확인했다.](/images/blog/terraform-docker-provider-plan-state-drift-lab/terraform-validate.png)

각 명령의 역할은 다르다.

| 명령 | 확인하는 것 | Docker resource 생성 여부 |
| --- | --- | --- |
| `init` | Provider download, backend 초기화, `.terraform.lock.hcl` 생성 | 생성하지 않음 |
| `fmt -check` | HCL formatting | 생성하지 않음 |
| `validate` | HCL과 Provider schema 기준의 정적 유효성 | 생성하지 않음 |

실습에서는 `init` 뒤 `kreuzwerker/docker v4.5.0`이 선택됐고, `.terraform.lock.hcl`이 만들어졌다. version constraint는 `~> 4.2`이므로 호환 범위 내 최신 patch/minor 버전이 선택될 수 있다. `.terraform/`은 내려받은 plugin cache라 Git에 넣지 않지만, `.terraform.lock.hcl`은 팀이 동일한 Provider를 재현하도록 보통 commit한다.

## 3. apply 전에 plan을 읽는다

```bash
terraform plan -out=first.tfplan
```

![첫 terraform plan 결과. image, network, container 세 resource를 새로 만들 계획임을 확인했다.](/images/blog/terraform-docker-provider-plan-state-drift-lab/terraform-first-plan.png)

첫 실행에서는 아래처럼 읽는 것이 핵심이다.

```text
Plan: 3 to add, 0 to change, 0 to destroy.

docker_image.nginx
docker_network.lab
docker_container.nginx
```

`plan`은 실제 Docker API를 조회해 현재 상태를 refresh하고, configuration과 state를 비교해 변경안을 만든다. 아직 `apply`하지 않았으므로 Nginx container는 생성되지 않는다.

`-out=first.tfplan`은 검토한 변경안을 파일로 저장한다. 실무에서는 review한 plan과 apply 대상이 달라지지 않게 하는 데 유용하지만, plan file도 state와 마찬가지로 민감 값이 포함될 수 있으므로 Git에 commit하지 않는다.

## 4. 저장한 plan을 적용하고 HTTP 응답을 확인한다

```bash
terraform apply first.tfplan
```

![저장한 first.tfplan을 적용한 결과. image, network, container 세 resource가 생성되고 nginx_url output이 출력됐다.](/images/blog/terraform-docker-provider-plan-state-drift-lab/terraform-first-apply.png)

실제 실행에서는 아래 결과를 확인했다.

```text
Apply complete! Resources: 3 added, 0 changed, 0 destroyed.
nginx_url = "http://127.0.0.1:18080"
```

Nginx process가 시작되는 순간과 Terraform apply가 끝나는 순간은 완전히 같지 않을 수 있다. apply 직후 첫 요청에서 빈 응답을 받았고, 잠시 뒤 재시도해 HTTP 200을 확인했다. 단순한 `apply` 성공만으로 application readiness까지 증명하지 않는다는 작은 예시다.

```bash
for i in {1..10}
do
  if curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:18080
  then
    break
  fi
  sleep 1
done

docker ps --filter name=terraform-docker-lab-nginx \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

기대 결과는 `terraform-docker-lab-nginx`, `nginx:1.27-alpine`, `0.0.0.0:18080->80/tcp`, HTTP 200이다.

## 5. state가 무엇을 추적하는지 확인한다

```bash
terraform state list
terraform state show docker_container.nginx
```

`state list`에는 다음 세 resource address가 나온다.

```text
docker_container.nginx
docker_image.nginx
docker_network.lab
```

`state show`에서는 container ID, image digest, port mapping, network 정보처럼 configuration만으로는 알 수 없는 실제 Docker object 정보가 보인다. Terraform은 이 연결 정보를 이용해 다음 plan에서 "새로 만들 resource인지", "기존 resource 변경인지", "삭제 대상인지"를 판단한다.

이번 실행의 `state show`에서는 다음 실제 연결 정보를 확인했다. 컨테이너 ID와 MAC address 전체는 글에서 제외했다.

```hcl
name  = "terraform-docker-lab-nginx"
image = "sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10"

network_data {
  network_name = "terraform-docker-lab"
}

ports {
  external = 18080
  internal = 80
  ip       = "0.0.0.0"
  protocol = "tcp"
}
```

state에는 password, token, connection 정보가 들어갈 수 있다. 이 lab의 Docker resource에는 그런 값이 없지만, `terraform.tfstate`, backup, saved plan, 민감한 `.tfvars`는 `.gitignore`에 넣는 습관을 이 단계부터 가져가는 편이 좋다.

## 6. Docker CLI로 drift를 만들고 복구한다

이제 Terraform 밖에서 실제 container만 삭제한다.

```bash
docker rm -f terraform-docker-lab-nginx
terraform plan -out=drift-recovery.tfplan
```

![Docker CLI로 container를 삭제한 뒤 실행한 plan. image와 network는 유지되고 container 한 개만 복구 대상으로 잡혔다.](/images/blog/terraform-docker-provider-plan-state-drift-lab/terraform-drift-plan.png)

configuration은 여전히 container가 있어야 한다고 말하고, 기존 state도 그 container를 알고 있다. 하지만 plan 중 Docker API refresh가 실제 container가 사라진 사실을 확인한다. 실습 결과는 다음과 같았다.

```text
Plan: 1 to add, 0 to change, 0 to destroy.

docker_container.nginx will be created
```

image와 network는 그대로 있으므로 3개 전체를 다시 만드는 것이 아니라 container 1개만 복구 대상으로 잡는다. 이 차이가 Terraform state와 실제 API 상태 비교를 가장 직접적으로 보여준다.

```bash
terraform apply drift-recovery.tfplan
curl -fsSI http://127.0.0.1:18080
```

![drift recovery plan 적용 뒤 container 한 개가 다시 생성됐고, curl로 HTTP 200 응답을 확인했다.](/images/blog/terraform-docker-provider-plan-state-drift-lab/terraform-drift-apply-health-check.png)

실제 apply 뒤 HTTP 200을 다시 확인했다. 이 실습에서 말하는 drift는 Docker CLI가 state 밖에서 resource를 바꿔, 선언한 상태와 실제 상태가 달라진 경우다. 사람이 수정한 resource를 Terraform이 무조건 되돌려야 한다는 뜻은 아니다. production에서는 어떤 변경을 Terraform이 소유하고, 어떤 수동 조치가 허용되는지부터 합의해야 한다.

## 7. configuration 변경도 plan으로 먼저 본다

`main.tf`의 host port를 바꾸고 plan 결과를 비교해 볼 수 있다.

```hcl
ports {
  internal = 80
  external = 18081
}
```

```bash
terraform plan
```

![host port를 18080에서 18081로 바꾼 plan. Provider schema가 container replacement가 필요하다고 제시하는지 실제 결과로 확인했다.](/images/blog/terraform-docker-provider-plan-state-drift-lab/terraform-replacement-plan.png)

여기서 중요한 것은 "port 변경은 항상 update다" 같은 답을 외우는 것이 아니다. 사용하는 Provider version과 resource schema가 제시하는 실제 plan을 읽어 `~` update인지, `-/+` replacement인지 확인하는 습관이다. 확인 뒤에는 `external = 18080`으로 되돌리거나, plan을 검토한 뒤 새 port로 apply한다.

## 8. destroy로 실습 resource만 정리한다

```bash
terraform destroy
```

![destroy 실행 결과. 이 lab의 state가 관리하던 image, network, container 세 resource만 제거됐다.](/images/blog/terraform-docker-provider-plan-state-drift-lab/terraform-destroy.png)

이 lab의 state에는 image, network, container 세 resource만 있으므로 destroy는 그 세 대상만 제안해야 한다. 실행 전에 plan에서 기존 application container나 다른 network가 섞이지 않았는지 확인한다.

실습 마지막 결과는 다음과 같았다.

```text
Destroy complete! Resources: 3 destroyed.
```

```bash
terraform state list
docker ps -a --filter name=terraform-docker-lab-nginx
docker network ls --filter name=terraform-docker-lab
```

세 명령 모두 관리 대상이 남지 않은 상태를 확인하면 끝이다.

## 이 실습에서 남긴 기준

1. Terraform은 Docker CLI context 자체가 아니라 Provider가 접근할 endpoint를 사용한다. 로컬 runtime이 Colima, Docker Desktop, remote daemon 중 무엇인지 먼저 확인한다.
2. `validate` 성공은 Docker daemon 연결이나 application readiness를 보장하지 않는다.
3. `plan`은 apply 전 확인할 변경 계약이고, state는 code와 실제 resource를 연결하는 기록이다.
4. `apply` 성공 뒤에도 HTTP health check처럼 application 수준 검증을 별도로 둔다.
5. drift를 한 번 의도적으로 만들어 보면 Terraform이 state만 믿는 도구가 아니라 Provider API의 실제 상태를 refresh해 비교한다는 점이 분명해진다.
6. Docker container를 Terraform으로 만들 수 있다는 사실과, 실무 application workload를 Terraform이 소유해야 한다는 판단은 다르다. Argo CD가 Deployment를 관리한다면 같은 resource를 Terraform이 함께 관리하지 않는다.

이 lab을 마친 뒤 다음으로 확장할 대상은 현재 RKE2 application이 아니라 별도 `terraform-lab` Namespace, RBAC, ResourceQuota처럼 Argo CD와 소유권이 겹치지 않는 Kubernetes foundation이다.

## 참고 자료

- [HashiCorp: Build infrastructure with Docker](https://developer.hashicorp.com/terraform/tutorials/docker-get-started/docker-build)
- [HashiCorp: Terraform state](https://developer.hashicorp.com/terraform/language/state)
- [HashiCorp: Manage sensitive data](https://developer.hashicorp.com/terraform/language/manage-sensitive-data)
- [HashiCorp: Terraform provisioners](https://developer.hashicorp.com/terraform/language/provisioners)
- [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/)
