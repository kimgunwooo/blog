---
title: 'Ansible idempotency를 changed 수로만 보면 안 되는 이유'
description: '같은 playbook을 반복 실행하면서 changed 결과를 어떻게 해석해야 하는지 정리했다.'
category: 'Automation'
pubDate: '2026-07-02'
tags: ['ansible', 'provisioning', 'idempotency', 'homelab']
---

Ansible을 처음 쓸 때는 “두 번째 실행에서 `changed=0`이 나오면 좋은 playbook”이라고 단순하게 생각했다. 그런데 실제로는 changed가 남아도 문제가 아닐 수 있고, 반대로 changed가 0이어도 검증이 충분하지 않을 수 있다.

이 글은 홈 랩 노드에 playbook을 반복 적용하면서 idempotency를 어떻게 봐야 하는지 정리한 메모다.

## 문제

노드 프로비저닝은 한 번 성공했다고 끝나지 않는다. 커널 파라미터, 패키지 설치, systemd 서비스, container runtime 설정은 재실행 시 매번 `changed`가 발생하면 실제 drift와 단순 재적용을 구분하기 어렵다.

수동으로 고친 설정이 플레이북과 충돌하는지도 확인해야 했다. 공개 글이므로 실제 호스트명, 사설 IP, 계정명, 인증 값은 모두 일반화했다.

## 실험/검증

검증 대상은 개인 홈 랩의 신규 워커 노드에 적용하는 기본 프로비저닝 플레이북이다. 역할은 OS 기본 패키지 설치, sysctl 설정, time sync, container runtime 준비, SSH hardening 정도로 제한했다.

첫 실행 후 같은 inventory에 대해 두 번째 실행을 수행하고, `changed=0`이 되는지 확인했다. 이후 의도적으로 sysctl 값 하나와 서비스 enable 상태 하나를 바꾼 뒤 세 번째 실행에서 필요한 항목만 복구되는지 봤다.

검증 기준은 단순했다.

- 첫 실행은 필요한 항목만 변경한다.
- 두 번째 실행은 변경 없음 상태가 된다.
- drift 주입 후 실행은 drift 항목만 변경한다.
- 인증 값, 개인 도메인, 실제 노드 식별자는 로그와 문서에 남기지 않는다.

## 결과

패키지 설치와 서비스 enable 작업은 대부분 idempotent하게 동작했다. 반면 파일 템플릿 일부는 trailing newline과 권한 값이 매번 달라져 반복 실행마다 `changed`가 발생했다.

가장 효과가 컸던 수정은 템플릿 결과를 고정하고, command/shell task를 모듈 task로 바꾸는 것이었다. 예를 들어 직접 명령으로 서비스를 켜는 대신 `ansible.builtin.systemd`를 사용하니 결과가 안정됐다.

두 번째 실행에서 `changed=0`에 가까워지자 이후 운영 로그 해석이 쉬워졌다. 변경이 발생하면 실제 drift인지, 플레이북이 아직 idempotent하지 않은지 좁혀 볼 수 있었다.

## 한계

홈 랩 규모의 검증이라 OS 이미지 종류와 하드웨어 조합이 제한적이다. 네트워크 불안정, mirror 장애, 패키지 저장소 갱신처럼 외부 상태가 바뀌는 상황은 충분히 재현하지 못했다.

또한 idempotency가 곧 안전한 변경을 의미하지는 않는다. 같은 결과를 반복해서 만든다는 것과 그 결과가 운영에 적절하다는 것은 별개다.

## 다음 개선

다음 단계는 Molecule 또는 임시 VM 기반 검증을 붙여 PR 단위로 idempotency를 확인하는 것이다. 홈 Kubernetes 노드에 직접 적용하기 전에 테스트 inventory에서 두 번 실행하고, 두 번째 실행의 changed 수를 CI 결과로 남길 계획이다.

장기적으로는 task 작성 패턴과 검증 결과를 나눠서 남길 생각이다. 글에서는 “Ansible이 항상 멱등적이다”가 아니라 “멱등적인 모듈을 우선 쓰고, command/shell은 조건을 명시해야 한다”는 기준을 계속 확인하려고 한다.
