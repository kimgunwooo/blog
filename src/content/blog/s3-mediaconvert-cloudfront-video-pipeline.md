---
title: 'S3, MediaConvert, CloudFront로 영상 처리 파이프라인을 설계한 기록'
description: 'Presigned URL 업로드부터 MediaConvert 변환, SQS 상태 이벤트, CloudFront 전달까지 영상 처리 경계를 정리했다.'
category: 'Cloud'
pubDate: '2024-08-11'
createdAt: '2026-07-23T11:25:24+09:00'
updatedDate: '2026-07-23'
tags: ['aws', 's3', 'mediaconvert', 'cloudfront', 'lambda', 'sqs', 'video']
---

영상 업로드와 스트리밍을 직접 구현하려고 하면 파일 업로드, 인코딩, 썸네일, 배포, 완료 알림까지 한 번에 얽힌다.

이 글은 S3 Presigned URL, MediaConvert, Lambda trigger, CloudFront, SQS를 하나의 end-to-end 영상 처리 파이프라인으로 연결해본 기록이다. 목표는 애플리케이션 서버가 대용량 영상 파일을 직접 들고 있지 않게 만들고, AWS 관리형 서비스를 이용해 비동기 처리 흐름을 만드는 것이었다.

## 전체 흐름

최종 흐름은 아래처럼 잡았다.

![Video processing architecture](/images/blog/s3-mediaconvert-cloudfront-video-pipeline/video-processing-architecture.png)

```text
client
  -> application server에 업로드 시작 요청
  -> S3 presigned URL 발급
  -> client가 S3 input bucket에 직접 업로드
  -> S3 object created event
  -> Lambda가 MediaConvert job 생성
  -> MediaConvert가 HLS/thumbnail 생성
  -> output bucket 저장
  -> MediaConvert state change event
  -> SNS/SQS
  -> application server가 상태 소비
  -> client에 완료 알림
  -> CloudFront URL로 재생
```

이 구조에서 애플리케이션 서버는 파일을 직접 받지 않는다. 서버는 업로드 권한을 발급하고, 완료 이벤트를 처리하고, 결과 URL을 저장하는 역할만 한다.

## S3 bucket 분리

처음에는 input과 output을 분리했다.

| bucket | 역할 |
| --- | --- |
| input bucket | client가 원본 영상을 업로드 |
| output bucket | MediaConvert 결과물과 thumbnail 저장 |

같은 bucket 안에서 prefix만 나누는 방법도 있지만, 실습에서는 역할을 명확히 보기 위해 bucket을 나눴다.

prefix는 user 기준으로 잡았다.

```text
vod/user/{userId}/{uuid}/{filename}
```

게시글 ID를 prefix에 넣을 수도 있었지만, 업로드 시점에는 아직 게시글이 확정되지 않을 수 있다. 그래서 당시 구성에서는 user ID와 UUID 중심으로 경로를 잡았다.

## Presigned URL 업로드

대용량 영상 파일을 애플리케이션 서버로 받은 뒤 다시 S3에 올리면 서버가 병목이 된다. 그래서 client가 S3에 직접 업로드하도록 Presigned URL을 사용했다.

흐름은 세 단계다.

```text
initiate multipart upload
  -> part별 presigned URL 발급
  -> client가 S3에 PUT
  -> ETag 목록으로 complete multipart upload
```

서버는 파일 이름, 크기, content type 같은 metadata를 받아 multipart upload를 시작한다. part별 URL은 짧은 만료 시간으로 발급하고, client는 각 part 업로드 결과로 받은 `ETag`를 모아 완료 요청을 보낸다.

운영 기준으로는 아래를 봐야 한다.

- URL 만료 시간
- 업로드 가능한 content type
- object key 규칙
- incomplete multipart lifecycle
- client가 보관해야 하는 part number와 ETag

incomplete multipart upload를 일정 기간 뒤 정리하도록 S3 lifecycle도 같이 봤다.

## Lambda와 MediaConvert

S3 input bucket에 영상이 올라오면 Lambda가 실행되고, Lambda는 MediaConvert job을 생성한다.

```text
S3 event
  -> source bucket/key 파싱
  -> userId, uuid, fileName 추출
  -> job.json template 로드
  -> MediaConvert input/output path 치환
  -> create_job 호출
```

MediaConvert는 원본 영상을 HLS로 변환하고, thumbnail도 생성한다. 당시 구성에서는 480p, 720p 같은 복수 화질과 썸네일 생성을 다뤘다.

여기서 중요한 것은 Lambda 코드 자체보다 경로 규칙이다. S3 key에서 user ID와 UUID를 추출하므로, upload prefix 규칙이 Lambda와 MediaConvert output 규칙의 계약이 된다.

```text
input:  vod/user/{userId}/{uuid}/{filename}
output: user/{userId}/vod/hls/{uuid}/{basename}
thumb:  user/{userId}/vod/thumbnail/{uuid}/{basename}
```

이 계약이 깨지면 job은 만들어져도 결과 URL을 애플리케이션이 찾지 못한다.

## CloudFront 전달

MediaConvert 결과물은 output bucket에 저장하고, client는 CloudFront URL로 접근하게 했다.

```text
output S3
  -> CloudFront distribution
  -> HLS manifest / segment / thumbnail delivery
```

CloudFront를 붙이는 이유는 단순히 URL을 예쁘게 만들기 위해서가 아니다. 영상 segment는 반복적으로 조회되므로 edge cache 효과가 있고, S3를 직접 공개하는 것보다 접근 경계를 분리할 수 있다.

운영에서는 cache policy, origin access, signed URL 필요 여부도 같이 봐야 한다.

## 상태 이벤트

영상 인코딩은 비동기 작업이다. client는 업로드 직후 결과 파일의 정확한 URL을 알 수 없다. 그래서 MediaConvert job 상태 변경 이벤트를 사용했다.

처리 구조는 아래처럼 잡았다.

```text
MediaConvert job state change
  -> EventBridge / CloudWatch Events
  -> SNS
  -> SQS
  -> application server consume
  -> client notification
```

SQS에 쌓인 메시지를 Spring server가 소비하고, job metadata에서 user ID, UUID, output path를 읽어 완료 알림을 만들었다. 당시 client 알림은 SSE로 보냈다.

```text
ENCODING_FINISH
videoUrl: CloudFront HLS URL
thumbnailUrl: CloudFront thumbnail URL
```

SSE가 항상 정답은 아니다. 인코딩 완료만 확인하면 polling이나 long polling이 더 단순할 수도 있다. 댓글, 팔로우, 업로드 완료 등 여러 실시간 알림을 같이 다룰 계획이라면 SSE를 재사용할 수 있다.

## 트러블슈팅 1: S3 trigger가 남아 있던 문제

실습 중 Lambda 함수를 지웠는데 S3 event notification이 기대처럼 정리되지 않아 prefix 제약이 남은 적이 있었다.

처음에는 image와 video를 모두 input bucket에 올리고, image는 copy Lambda로 output에 복사하는 구조를 생각했다. 이후 이미지는 직접 output으로 올리는 방식으로 바꾸며 copy Lambda를 삭제했는데, S3 bucket의 event notification 설정이 남아 있어 새 trigger prefix 설정에 계속 제약이 생겼다.

확인은 S3 bucket의 속성 탭에서 event notification 목록을 직접 봐야 했다.

운영 기준으로는 Lambda만 삭제했다고 event source mapping이나 S3 notification까지 정리됐다고 가정하면 안 된다.

## 트러블슈팅 2: 영상 비율

MediaConvert로 HLS와 thumbnail이 생성됐지만, 재생 화면에서 영상 비율이 깨지는 문제가 있었다. 원인은 output scaling 설정이었다.

AWS MediaConvert에는 여러 scaling 방식이 있고, 실습에서는 `FIT_NO_UPSCALE`을 선택했다. 작은 영상을 억지로 키우지 않고, 비율을 유지하며 맞추는 방식이다.

job template에 아래와 같은 설정을 반영했다.

```json
{
  "ScalingBehavior": "FIT_NO_UPSCALE"
}
```

영상 파이프라인에서는 “파일이 만들어졌다”만으로 성공을 판단하면 부족하다. 실제 재생 화면에서 aspect ratio, thumbnail, HLS manifest, segment 접근까지 확인해야 한다.

## 운영 기준

이 파이프라인에서 확인해야 할 지점은 많다.

| 구간 | 확인 |
| --- | --- |
| upload | multipart 완료, incomplete upload 정리 |
| trigger | prefix/suffix 조건, 중복 event notification |
| transform | job 생성 실패, job status, output path |
| delivery | CloudFront cache, origin 접근, HLS 재생 |
| notification | SQS 적재, 중복 소비, 실패 재처리 |
| cleanup | 원본 보관 기간, output 삭제 정책 |

비동기 파이프라인은 중간 단계가 하나만 실패해도 사용자는 “영상이 안 올라간다”고 느낀다. 그래서 각 단계의 상태를 따로 볼 수 있어야 한다.

## 정리

이 구조에서 가장 중요한 결정은 파일을 애플리케이션 서버 밖으로 빼는 것이었다.

```text
server uploads file
```

보다

```text
server issues upload permission
client uploads to S3
server observes result event
```

가 더 운영하기 좋은 경계였다.

S3, Lambda, MediaConvert, CloudFront, SQS를 붙이면 기능은 빠르게 만들 수 있다. 다만 서비스가 늘어날수록 진짜 문제는 각 서비스 사이의 계약이다. S3 key 규칙, event 조건, output path, notification payload가 문서화되어 있어야 나중에 디버깅할 수 있다.

원문:

- [S3 Presigned URL 업로드](https://velog.io/@kimgunwooo/Aws-S3-Presigned-Url%EC%9D%84-%ED%86%B5%ED%95%9C-%EC%97%85%EB%A1%9C%EB%93%9C)
- [동영상 처리 파이프라인](https://velog.io/@kimgunwooo/%EB%8F%99%EC%98%81%EC%83%81-%EC%B2%98%EB%A6%AC-%EC%96%B4%EB%96%BB%EA%B2%8C-%ED%95%98%EB%8A%94%EA%B2%8C-%EC%A2%8B%EC%9D%84%EA%B9%8C-Mediaconvert-S3-CloudFront-CloudWatch-SNS-SQS)
- [S3 Lambda trigger 삽질](https://velog.io/@kimgunwooo/S3-lambda-trigger-%EC%82%BD%EC%A7%88)
- [AWS MediaConvert 비디오 조정](https://velog.io/@kimgunwooo/AWS-MediaConvert-%EB%B9%84%EB%94%94%EC%98%A4-%EC%A1%B0%EC%A0%95)
