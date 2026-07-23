---
title: 'Raspberry Pi 4에 Kubespray로 Kubernetes를 올릴 때 막힌 지점들'
description: 'Ubuntu 22.04, ARM 환경, DNS, CNI, CoreDNS 문제를 Kubespray 설치 흐름 기준으로 다시 정리했다.'
category: 'Kubernetes'
pubDate: '2025-04-12'
updatedDate: '2026-07-23'
tags: ['kubernetes', 'kubespray', 'raspberry-pi', 'ansible', 'homelab']
---

Raspberry Pi 4 세 대에 Ubuntu 22.04를 설치하고, Kubespray로 Kubernetes 클러스터를 올리려고 했다.

교재를 그대로 따라가는 방식으로 시작했지만, 실제로 막힌 부분은 버전, ARM 환경, DNS, CNI, 재시도 방식이었다. 설치가 실패할 때마다 같은 명령을 다시 치는 것이 아니라, 어느 상태가 남아 있는지 먼저 지워야 한다는 점도 이때 배웠다.

## 환경

구성은 작게 잡았다.

| 항목 | 값 |
| --- | --- |
| 노드 | Raspberry Pi 4 3대 |
| OS | Ubuntu 22.04 |
| 설치 도구 | Kubespray 2.25.1 |
| 실행 방식 | Ansible playbook |
| 목적 | 개인 Kubernetes 클러스터 구성 |

호스트명, 내부 IP, 계정명은 공개 글에서는 일반화했다. 실제 inventory는 control plane 1대와 worker 2대로 나눴다.

```ini
[all]
node-01 ansible_host=192.168.x.1 ansible_user=user1
node-02 ansible_host=192.168.x.2 ansible_user=user2
node-03 ansible_host=192.168.x.3 ansible_user=user3

[kube_control_plane]
node-01

[etcd]
node-01

[kube_node]
node-02
node-03

[k8s_cluster:children]
kube_control_plane
kube_node
```

설치 자체는 아래 playbook으로 진행했다.

```bash
ansible-playbook -i inventory/k8s_cluster/inventory.ini \
  --become --become-user=root \
  cluster.yml
```

## 문제 1: Ubuntu 22.04와 dummy module

처음 만난 문제는 Ubuntu 22.04에서 `dummy` kernel module이 빠져 있어 NodeLocal DNS 관련 단계에서 실패하는 것이었다. Kubespray 이슈에서도 언급된 문제였고, 해결 방향은 둘 중 하나였다.

- `dummy` module을 설치한다.
- `enable_nodelocaldns`를 `false`로 둔다.

학습 환경에서는 빠르게 클러스터를 올리는 것이 목적이었기 때문에 `enable_nodelocaldns: false`로 진행했다. 운영 환경이라면 왜 NodeLocal DNS를 끄는지, 이후 DNS latency와 장애 범위가 어떻게 바뀌는지 따로 확인해야 한다.

## 문제 2: 실패 후 reset 없이 재실행

가장 시간을 많이 쓴 부분은 설치 실패 후 상태를 지우지 않고 다시 설치를 반복한 것이었다.

Kubespray는 Ansible 기반이라 실패한 task 이후에도 노드에 일부 설정이 남는다. container runtime, kubelet, CNI 파일, kubeadm 상태가 일부 남아 있으면 다음 설치에서 새로운 오류처럼 보이는 문제가 생긴다.

실패 후에는 바로 `cluster.yml`을 다시 돌리기보다 `reset.yml`로 상태를 지우고 다시 시작하는 편이 낫다.

```bash
ansible-playbook -i inventory/k8s_cluster/inventory.ini \
  --become --become-user=root \
  reset.yml
```

이 명령도 시간이 걸리지만, 원인을 모르는 잔여 상태를 들고 재시도하는 것보다 훨씬 싸다.

## 문제 3: kubectl context가 비어 있음

kubelet은 정상처럼 보이는데 master node에서 `kubectl cluster-info`가 실패했다. 원인은 kubectl이 바라볼 kubeconfig가 제대로 잡히지 않은 상태였다.

이 경우에는 control plane에서 `/etc/kubernetes/admin.conf`를 사용자 kubeconfig로 복사하고 권한을 맞춰야 한다.

```bash
mkdir -p "$HOME/.kube"
sudo cp /etc/kubernetes/admin.conf "$HOME/.kube/config"
sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"
```

운영 기준으로는 설치 완료를 `kubelet active`만 보고 판단하면 부족하다. 최소한 아래 셋은 같이 봐야 했다.

```bash
systemctl status kubelet
kubectl cluster-info
kubectl get nodes -o wide
```

## 문제 4: resolv.conf가 다시 덮어써짐

worker node에서 DNS 해석이 되지 않는 문제가 있었다. `resolv.conf`를 직접 수정해도 `systemd-resolved`나 네트워크 설정이 다시 덮어쓸 수 있다.

당시에는 `/etc/resolv.conf`를 다시 만들고 nameserver를 고정하는 방식으로 해결했다.

```bash
sudo rm /etc/resolv.conf
sudo touch /etc/resolv.conf
echo 'nameserver 1.1.1.1' | sudo tee /etc/resolv.conf
sudo systemctl restart systemd-resolved.service
```

다만 이 방식은 임시 대응에 가깝다. 장기적으로는 netplan, systemd-resolved, Kubespray DNS 설정 중 어디가 실제 source of truth인지 정해야 한다. 그렇지 않으면 다음 재부팅이나 playbook 재실행에서 같은 문제가 다시 생길 수 있다.

## 문제 5: Calico 대신 Flannel

Raspberry Pi 같은 ARM 환경에서는 Calico 조합에서 pod가 안정적으로 뜨지 않는 경우가 있었다. Calico 설정을 계속 조정하기보다, 작은 홈 랩에서는 Flannel로 단순화하는 쪽을 선택했다.

Kubespray 설정에서 network plugin을 바꿨다.

```yaml
kube_network_plugin: flannel
```

이 선택은 기능을 줄이는 대신 설치와 디버깅 비용을 줄인다. NetworkPolicy 같은 기능이 꼭 필요하면 Calico를 다시 봐야 하지만, 처음 클러스터를 올리고 Kubernetes 운영 흐름을 익히는 단계에서는 단순한 CNI가 더 나았다.

## 문제 6: CoreDNS loop

CoreDNS에서 아래 오류가 발생했다.

```text
[FATAL] plugin/loop: Loop detected for zone "."
```

CoreDNS가 DNS 요청을 `/etc/resolv.conf`로 forward했는데, 그 경로가 다시 CoreDNS를 가리키며 loop가 생긴 상황이었다. CoreDNS ConfigMap에서 forward 대상을 명시적인 public resolver로 바꿨다.

```text
forward . 8.8.8.8 1.1.1.1
```

수정 후 CoreDNS pod를 재시작했다.

```bash
kubectl -n kube-system delete pod -l k8s-app=kube-dns
```

여기서도 중요한 것은 “DNS가 안 된다”를 하나의 문제로 보지 않는 것이다. Node의 resolver, CoreDNS ConfigMap, CNI, kube-proxy 상태를 나눠서 확인해야 한다.

## 결과

최종적으로 control plane과 worker node가 모두 join된 것을 확인했다.

```bash
kubectl get nodes -o wide
```

이 설치 기록에서 남은 기준은 세 가지다.

1. 실패한 Kubespray 설치는 reset 후 다시 본다.
2. ARM 홈 랩에서는 CNI 선택을 단순하게 시작한다.
3. DNS 문제는 node resolver와 CoreDNS forward 경로를 분리해서 확인한다.

## 다음에 다시 한다면

처음부터 설치 체크리스트를 아래처럼 둘 것이다.

| 단계 | 확인 |
| --- | --- |
| 사전 준비 | SSH, sudo, swap, firewall, kernel module |
| 설치 전 | inventory, Kubespray version, CNI 선택 |
| 실패 시 | `reset.yml` 실행 후 재시도 |
| 설치 후 | kubeconfig, node readiness, CoreDNS, CNI pod |
| 문서화 | 변경한 group_vars와 실패 로그 기록 |

Kubespray는 “한 번에 설치되는 도구”라기보다, Ansible로 Kubernetes 구성 요소를 어떤 순서로 올리는지 보여주는 좋은 실험 대상이었다. 홈 랩에서는 설치 성공보다 실패 후 어디서 상태가 남는지 확인하는 과정이 더 값졌다.

원문: [kubespray 설치 삽질](https://velog.io/@kimgunwooo/kubespray-%EC%84%A4%EC%B9%98-%EC%82%BD%EC%A7%88-Raspberry-Pi-4-Ubuntu22.04)
