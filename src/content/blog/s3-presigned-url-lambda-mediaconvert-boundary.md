---
title: 'Presigned URL과 S3 이벤트로 영상 처리 책임을 나누기'
description: '대용량 영상 업로드에서 서버가 파일을 직접 받지 않고, 업로드 권한과 비동기 변환 이벤트만 관리하도록 나눈 기준을 정리했다.'
category: 'Cloud'
pubDate: '2024-08-02'
updatedDate: '2026-07-23'
tags: ['aws', 's3', 'presigned-url', 'lambda', 'mediaconvert', 'multipart-upload']
---

영상 업로드를 서버가 직접 받으면 구현은 단순해 보인다. 하지만 파일 크기가 커질수록 애플리케이션 서버가 네트워크와 메모리 병목이 된다. 서버가 받은 파일을 다시 S3에 올리는 구조라면 같은 파일을 두 번 이동시키는 셈이다.

그래서 업로드 경계는 다르게 잡았다. 서버는 파일을 받지 않고, S3에 업로드할 수 있는 짧은 권한만 발급한다. 파일은 client가 S3로 직접 올리고, 이후 처리는 S3 event와 Lambda가 이어받는다.

이 글은 전체 영상 파이프라인보다 한 단계 좁게, 업로드 권한 발급과 S3 event/Lambda/MediaConvert 사이의 책임 경계를 정리한 기록이다.

## 서버가 맡지 않을 일

처음 나눈 기준은 아래다.

| 책임 | 담당 |
| --- | --- |
| 파일 binary 전송 | client -> S3 |
| 업로드 권한 발급 | application server |
| 업로드 완료 확인 | application server |
| 영상 변환 시작 | S3 event -> Lambda |
| HLS/thumbnail 생성 | MediaConvert |
| 결과 상태 반영 | SQS consumer / application server |

이렇게 나누면 애플리케이션 서버는 대용량 파일을 직접 들고 있지 않는다. 대신 object key 규칙, Presigned URL 만료 시간, multipart upload 완료 여부, 변환 job 상태를 관리한다.

## Presigned URL 업로드

업로드는 multipart upload 기준으로 잡았다.

![Multipart presigned URL flow](/images/blog/s3-presigned-url-lambda-mediaconvert-boundary/multipart-presigned-url-flow.png)

흐름은 세 단계다.

```text
1. client -> server: 업로드 시작 요청
2. server -> S3: multipart upload 생성
3. server -> client: part별 presigned URL 반환
4. client -> S3: 각 part를 PUT 업로드
5. client -> server: partNumber / ETag 목록으로 완료 요청
6. server -> S3: complete multipart upload
```

서버는 파일명, 파일 크기, content type을 받아 multipart upload를 시작한다. 각 part URL은 짧은 만료 시간으로 발급하고, client는 S3 응답 header의 `ETag`를 보관했다가 완료 요청에 같이 보낸다.

여기서 중요한 값은 `uploadId`, `partNumber`, `ETag`다.

```text
uploadId: 하나의 multipart upload 식별자
partNumber: 업로드한 조각 순서
ETag: S3가 반환한 각 part의 결과 식별값
```

완료 요청에서 이 값들이 맞지 않으면 S3 object가 완성되지 않는다.

## Key 규칙이 계약이다

S3에 object가 올라온 뒤에는 Lambda가 key를 파싱해 MediaConvert job을 만든다. 그래서 key 규칙은 단순한 경로가 아니라 서비스 간 계약이다.

```text
input:
  vod/user/{userId}/{uuid}/{filename}

output:
  user/{userId}/vod/hls/{uuid}/{basename}
  user/{userId}/vod/thumbnail/{uuid}/{basename}
```

업로드 쪽에서 key 규칙을 바꾸면 Lambda와 MediaConvert output 규칙도 같이 바뀌어야 한다. 반대로 Lambda가 임의로 output path를 만들면 애플리케이션 서버가 결과 URL을 찾기 어려워진다.

## S3 event가 변환을 시작한다

영상 파일이 input bucket에 올라오면 S3 object created event로 Lambda가 실행된다.

![S3 Lambda trigger boundary](/images/blog/s3-presigned-url-lambda-mediaconvert-boundary/s3-lambda-trigger-boundary.png)

Lambda의 역할은 직접 인코딩이 아니다. S3 event에서 bucket/key를 읽고, MediaConvert job template에 input/output path를 채워 job을 생성한다.

```text
S3 object created
  -> Lambda
  -> key parse
  -> MediaConvert create job
  -> HLS / thumbnail output
```

이 경계가 좋았던 이유는 애플리케이션 서버와 영상 변환 worker가 분리되기 때문이다. 서버 배포와 인코딩 job 생성 로직을 한 프로세스에 묶지 않아도 된다.

## Trigger 설정에서 생긴 문제

실습 중 S3 event notification 때문에 시간이 걸린 적이 있었다.

처음에는 image와 video를 모두 input bucket에 올리고, image는 Lambda로 output bucket에 copy하려 했다. 이후 이미지는 output bucket에 직접 업로드하는 방식으로 바꾸면서 copy Lambda를 삭제했다. 그런데 Lambda만 삭제했다고 S3 bucket의 event notification 설정까지 같이 사라진 것은 아니었다.

결과적으로 S3 bucket에 이전 trigger 설정이 남아 있었고, 새 prefix 조건을 잡을 때 제약이 생겼다.

운영 기준은 간단하다.

```text
Lambda 삭제 != S3 event notification 삭제
```

S3 trigger 문제를 볼 때는 Lambda 함수 화면만 볼 것이 아니라, S3 bucket의 event notification 목록을 직접 확인해야 한다.

## MediaConvert는 파일 생성만 보면 안 된다

MediaConvert job이 성공하고 HLS 파일과 thumbnail이 만들어져도 끝이 아니다. 실제 재생 화면에서 비율이 깨지는 문제가 있었다.

![Video processing architecture with MediaConvert](/images/blog/s3-presigned-url-lambda-mediaconvert-boundary/video-processing-architecture.png)

원인은 output scaling 설정이었다. 영상마다 원본 비율이 다르기 때문에, 단순히 원하는 해상도로 맞추면 화면이 늘어나거나 잘릴 수 있다. 실습에서는 `FIT_NO_UPSCALE`을 사용해 작은 영상을 억지로 키우지 않고 비율을 유지하게 했다.

```json
{
  "ScalingBehavior": "FIT_NO_UPSCALE"
}
```

영상 처리에서 성공 기준은 “파일이 생성됐다”가 아니다.

- HLS manifest가 열리는가
- segment 파일 접근이 되는가
- thumbnail이 만들어지는가
- 원본 비율이 유지되는가
- CloudFront URL로 재생되는가
- job 실패 이벤트가 SQS로 남는가

이 기준을 확인해야 실제 사용자 화면에서 문제가 줄어든다.

## 운영 기준

이 구조에서 남긴 기준은 아래다.

1. 서버는 파일을 받지 말고 업로드 권한만 발급한다.
2. Presigned URL은 만료 시간, content type, object key 규칙을 같이 제한한다.
3. multipart upload는 `uploadId`, `partNumber`, `ETag`를 client와 명확히 주고받아야 한다.
4. S3 key 규칙은 Lambda와 MediaConvert output path의 계약이다.
5. Lambda 삭제 후에도 S3 event notification이 남아 있는지 확인한다.
6. MediaConvert 성공은 생성 여부가 아니라 실제 재생과 비율까지 확인한다.

S3, Lambda, MediaConvert를 붙이는 것은 어렵지 않다. 어려운 부분은 각 서비스가 어디까지 책임지는지 정하고, 그 사이의 계약을 깨지 않게 유지하는 것이다.

원문:

- [S3 Presigned URL 업로드](https://velog.io/@kimgunwooo/Aws-S3-Presigned-Url%EC%9D%84-%ED%86%B5%ED%95%9C-%EC%97%85%EB%A1%9C%EB%93%9C)
- [S3 Lambda trigger 삽질](https://velog.io/@kimgunwooo/S3-lambda-trigger-%EC%82%BD%EC%A7%88)
- [AWS MediaConvert 비디오 조정](https://velog.io/@kimgunwooo/AWS-MediaConvert-%EB%B9%84%EB%94%94%EC%98%A4-%EC%A1%B0%EC%A0%95)
