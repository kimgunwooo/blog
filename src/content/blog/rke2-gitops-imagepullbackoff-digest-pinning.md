---
title: 'ImagePullBackOff를 만났을 때 tag와 digest를 같이 봐야 하는 이유'
description: 'RKE2 홈 클러스터에서 ImagePullBackOff 원인을 나누고, digest pinning이 왜 필요한지 정리했다.'
category: 'Kubernetes'
pubDate: '2026-07-03'
tags: ['rke2', 'gitops', 'imagepullbackoff', 'digest-pinning']
---

Kubernetes에서 `ImagePullBackOff`를 보면 처음에는 “이미지를 못 가져왔구나” 정도로만 이해하기 쉽다. 그런데 실제 원인은 tag 없음, registry 인증 실패, 네트워크 문제, mutable tag 변경처럼 여러 가지로 나뉜다.

이 글은 RKE2 홈 클러스터에서 ImagePullBackOff를 재현하면서 tag와 digest를 어떻게 봐야 하는지 정리한 메모다.

## 문제

GitOps에서는 Git에 선언된 이미지가 클러스터 상태의 기준이 된다. 그런데 mutable tag를 계속 쓰면 같은 `app:latest`라도 시점에 따라 다른 이미지가 배포될 수 있다.

문제는 ImagePullBackOff가 발생했을 때 더 커진다. tag가 없는 것인지, registry 인증이 실패한 것인지, node에서 registry에 접근하지 못하는 것인지, tag가 다른 digest로 바뀐 것인지 한 번에 구분하기 어렵다.

## 실험/검증

검증은 홈 RKE2 클러스터의 샘플 namespace에서 진행했다. GitHub/GHCR 예시는 개인 계정 `kimgunwooo` 기준으로만 적고, 실제 registry 주소, repository 이름, 인증 설정 이름은 공개 문서에 남기지 않는다.

먼저 존재하지 않는 tag를 배포해 ImagePullBackOff 이벤트를 확인했다. 다음으로 인증 설정을 제거한 경우, registry 접근이 막힌 경우, 정상 tag지만 digest가 바뀐 경우를 나눠 이벤트와 GitOps controller 상태를 비교했다.

마지막으로 배포 manifest에 image digest를 pinning했다. tag 기반 선언과 `ghcr.io/kimgunwooo/sample-app@sha256:...` 같은 개인 GHCR digest 선언이 장애 분석과 rollback 판단에 어떤 차이를 만드는지 확인했다.

## 결과

ImagePullBackOff 자체는 증상일 뿐이고 원인은 이벤트 메시지와 node 접근성 확인까지 봐야 좁혀졌다. 존재하지 않는 tag와 인증 실패는 비슷하게 보이지만 event reason과 message에서 단서가 갈렸다.

digest pinning을 적용하니 재현성이 좋아졌다. Git에 기록된 digest가 실제 배포 대상이므로 나중에 같은 manifest를 적용했을 때 다른 이미지가 내려올 가능성이 줄었다.

다만 digest만 쓰면 사람이 어떤 버전을 배포했는지 읽기 어렵다. 운영 문서에서는 tag와 digest를 함께 기록하거나, 자동화가 PR에 tag, digest, build metadata를 같이 남기는 방식이 필요해 보였다.

## 한계

검증은 작은 홈 클러스터 기준이다. 대규모 클러스터의 registry mirror, image policy webhook, admission controller까지 포함하지 않았다.

또한 digest pinning은 공급망 보안의 일부일 뿐이다. 이미지 서명 검증, SBOM, 취약점 스캔까지 포함해야 더 넓은 운영 기준이 된다.

## 다음 개선

다음 단계는 GitOps 업데이트 자동화가 새 이미지를 발견했을 때 digest까지 PR로 남기게 만드는 것이다. controller가 적용한 결과와 registry metadata를 비교해 사람이 추적 가능한 변경 기록을 만들 계획이다.

다음에는 ImagePullBackOff 확인 순서를 더 짧은 체크리스트로 정리하고, GitOps 업데이트 자동화가 digest를 PR에 어떻게 남기는지 실험해볼 계획이다.
