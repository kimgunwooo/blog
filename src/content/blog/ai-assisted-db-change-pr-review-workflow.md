---
title: 'AI가 만든 DB 변경 초안을 바로 적용하지 않고 PR 검토 흐름에 둔 이유'
description: '반복되는 DDL·함수 변경 요청을 Codex/Claude skill과 Liquibase template로 정리하고, 생성·검토·적용 책임을 분리한 기록.'
category: 'Automation'
pubDate: '2026-07-27'
createdAt: '2026-07-29T00:00:43+09:00'
tags: ['ai-assisted', 'liquibase', 'database-change', 'git-pr', 'automation']
---

다른 팀에서 DB 변경이 필요할 때마다 DBA 팀에 요청이 모였다. 처음에는 changelog를 만드는 shell script와 README를 제공하면 충분할 것이라고 생각했다. 그러나 작성 규칙을 이해하는 데 시간이 들고, 함수·view·DDL마다 필요한 확인 항목이 달라 문의가 반복됐다.

문제를 “AI가 DB 변경을 자동 적용하게 하자”로 풀지 않았다. 대신 **AI가 검토 가능한 초안을 만들고, 사람은 변경 범위와 적용 여부를 통제하는 흐름**으로 나눴다.

> 이 글의 AI workflow는 로컬 개발 환경에서 Codex/Claude skill을 실행하는 방식이다. AI가 production DB에 접속하거나, 변경을 직접 적용하도록 구성하지 않았다.

## shell script와 README만으로는 경계가 모호했다

shell script는 정해진 파일 이름과 changelog 뼈대를 빨리 만들기 좋았다. README는 적용 순서와 기본 규칙을 남기기 좋았다. 하지만 요청자가 실제로는 다음을 한 번에 판단해야 했다.

- 이번 변경은 table, view, function, procedure 중 무엇인가?
- changeset id와 include 위치는 어디인가?
- 이전 object를 drop해야 하는가? rollback을 어떻게 볼 것인가?
- parameter 조합과 테스트 SQL은 무엇인가?
- PR에는 어떤 설명과 검증 결과를 남겨야 하는가?

정보는 있었지만 작업 단위로 연결돼 있지 않았다. “문서를 읽고 스크립트를 실행하라”는 방식은 빠른 요청 처리보다 해석 책임을 요청자에게 넘기고 있었다.

## 입력과 출력을 고정한 skill로 바꿨다

Codex/Claude에서 실행하는 DB Change Skill에 프로젝트별 입력·출력 규칙을 넣고 Git repository로 공유했다. 핵심은 model을 복잡하게 조합하는 것이 아니라, **작업 경계와 결과 형식을 고정하는 것**이었다.

![AI-assisted DB Change PR 검토 흐름](/images/blog/ai-assisted-db-change-pr-review-workflow/ai-assisted-db-change-flow.png)

*공유 Skill repository를 내려받아 로컬 Codex/Claude에서 변경 초안을 만들고, DB repository PR·DBA review·Jenkins/Liquibase 검증을 거쳐 적용하는 흐름입니다. AI에는 DB 접속·적용 권한을 주지 않았습니다.*

skill이 제공하는 입력에는 변경 목적, 대상 object, 환경, 예상 영향 범위가 들어간다. 출력에는 다음을 요구했다.

| 출력 | 목적 |
| --- | --- |
| Liquibase changelog 초안 | 적용 단위와 순서를 versioned change로 남김 |
| SQL 초안 | DDL·function·view 등 변경 내용을 검토 가능하게 제시 |
| rollback 고려사항 | 자동 rollback 가능 여부와 수동 절차 필요 여부를 분리 |
| 테스트 SQL / 체크리스트 | 적용 전후에 확인할 결과를 PR에 함께 남김 |

AI 결과가 항상 맞다고 전제하지 않았다. 모호한 요청이나 기존 object의 숨은 의존성은 답변 품질보다 repository context와 reviewer의 판단에 더 크게 좌우된다. 그래서 출력의 목적을 “정답 생성”보다 “리뷰 가능한 시작점 생성”으로 잡았다.

## 적용 권한은 사람과 CI에 남겼다

이 흐름에서 역할은 명확히 분리했다.

- **요청 팀**: 변경 목적과 예상 결과를 제공하고, skill이 만든 초안을 PR로 제출한다.
- **AI skill**: 규칙에 맞는 changelog·SQL·검증 체크리스트의 초안을 만든다.
- **DBA 팀**: 변경 순서, locking/영향 범위, rollback 가능성, test SQL을 검토하고 승인한다.
- **Jenkins/Liquibase**: 승인된 changeset의 적용 이력과 release 연결을 남긴다.

AI에게 DB credential이나 배포 권한을 주지 않은 이유도 여기에 있다. DB 변경은 생성보다 적용이 위험하다. 적용 시점에는 현재 schema, lock, data volume, 서비스 version, 장애 대응 가능 시간처럼 요청 문장만으로 알 수 없는 조건이 있다. PR review와 CI 검증을 통과한 결과만 적용하도록 두면, 적어도 누가 어떤 근거로 변경을 승인했는지 추적할 수 있다.

## 재사용성은 prompt 저장보다 작업 규칙에서 나왔다

처음에는 agent, tool, hook을 많이 붙일수록 재현성이 좋아질 것이라 생각했다. 실제로는 지시가 겹치면 검토 범위가 넓어지고 응답 시간이 길어졌다. 반복 요청에는 복잡한 orchestration보다 다음 세 가지가 더 효과적이었다.

1. **명확한 입력 경계**: 어떤 정보가 없으면 초안을 확정하지 않고 질문으로 돌린다.
2. **고정된 출력 형식**: SQL만 내지 않고 changelog, 검증 SQL, rollback 검토를 함께 낸다.
3. **PR 기반 기록**: prompt 자체보다 실제 변경 diff와 reviewer 피드백을 다음 작업의 기준으로 남긴다.

이 방식은 AI 사용량이나 token을 줄인다는 주장보다, 사람이 다시 검토할 수 있는 변경 단위를 만들었다는 점에 의미가 있다.

## 이 경험에서 남긴 기준

AI를 업무에 도입할 때 중요한 것은 “AI가 무엇을 구현했는가”보다 **누가 무엇을 결정하고, 오류가 나면 어디서 변경 이력을 확인할 수 있는가**라고 봤다.

DB Change Skill은 DBA 팀을 대체하는 자동화가 아니다. 반복적인 초안 작성과 형식 확인을 줄이되, 변경 범위 판단·review·approval·적용 검증은 Git PR과 Jenkins/Liquibase 절차 안에 남기는 보조 도구다. 이 경계가 있어야 팀이 빠르게 움직이면서도 DB 변경을 통제할 수 있다.

## 참고 자료

- [Liquibase change를 release 이력으로 다룬 기록](/blog/oracle-postgresql-liquibase-change-management/)
- [Jenkins Pipeline](https://www.jenkins.io/doc/book/pipeline/)
- [GitHub: About pull request reviews](https://docs.github.com/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews)
