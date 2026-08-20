---
title: '낙관적 락, 비관적 락, Redis 분산락을 언제 다르게 봐야 할까'
description: '재고 차감 예제를 기준으로 JPA optimistic lock, pessimistic lock, Redisson lock의 선택 기준을 정리했다.'
category: 'Database'
pubDate: '2025-02-11'
createdAt: '2026-07-23T11:25:24+09:00'
updatedDate: '2026-07-23'
tags: ['database', 'jpa', 'locking', 'redis', 'redisson']
---

동시성 제어는 “락을 건다”로 끝나지 않는다. 충돌이 드문지, 충돌이 잦은지, 서버가 여러 대인지, 실패했을 때 재시도해도 되는 요청인지에 따라 선택이 달라진다.

이 글은 낙관적 락, 비관적 락, Redis 분산락을 각각 구현해보며 어떤 상황에서 다른 선택을 해야 하는지 정리한 기록이다.

## 예제 상황

한정 수량 상품을 구매하는 API를 가정했다.

```text
여러 사용자가 동시에 구매 요청을 보낸다.
재고가 부족하면 실패해야 한다.
재고보다 많은 주문이 저장되면 안 된다.
```

핵심은 재고 감소와 주문 저장이 같은 트랜잭션 안에서 일관되게 처리되어야 한다는 점이다.

## 낙관적 락

낙관적 락은 “대부분 충돌하지 않을 것”이라고 보고 먼저 진행한 뒤, commit 시점에 version 충돌을 감지한다.

JPA에서는 `@Version` 필드를 둔다.

```java
@Entity
class Product {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private int stock;

    @Version
    private int version;

    public boolean reduceStock(int quantity) {
        if (stock < quantity) return false;
        stock -= quantity;
        return true;
    }
}
```

충돌이 발생하면 `OptimisticLockingFailureException` 계열 예외가 발생하고, 트랜잭션은 롤백된다. 그래서 낙관적 락은 재시도 정책과 함께 생각해야 한다.

```java
@Transactional
@Retryable(
    value = OptimisticLockingFailureException.class,
    maxAttempts = 3,
    backoff = @Backoff(delay = 100, multiplier = 2)
)
public void purchaseProduct(Long productId, int quantity, Long userId) {
    Product product = productRepository.findById(productId)
        .orElseThrow();

    if (!product.reduceStock(quantity)) {
        throw new IllegalStateException("stock is not enough");
    }

    orderRepository.save(new Order(productId, userId, quantity));
}
```

낙관적 락은 충돌이 낮은 구간에서 유리하다. 반대로 이벤트 상품처럼 같은 row에 요청이 몰리면 계속 충돌하고 재시도하면서 오히려 비용이 커질 수 있다.

## 비관적 락

비관적 락은 “충돌이 날 가능성이 높다”고 보고 먼저 DB row lock을 잡는다.

```java
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("select p from Product p where p.id = :id")
Product findByIdWithPessimisticLock(@Param("id") Long id);
```

이 방식은 동시에 같은 상품 재고를 수정하는 요청을 DB에서 직렬화한다. 재고 초과 판매를 막는 데 직관적이지만, lock 대기 시간이 길어질 수 있고 transaction 범위가 커지면 DB 부하가 커진다.

비관적 락을 쓸 때는 아래를 같이 봐야 한다.

- lock을 잡은 뒤 수행하는 로직이 짧은가
- 외부 API 호출이나 긴 계산이 transaction 안에 들어가지 않는가
- lock timeout을 어떻게 둘 것인가
- 대기 실패를 사용자에게 어떻게 반환할 것인가

DB lock은 강력하지만, transaction 경계를 잘못 잡으면 병목 지점이 된다.

## Redis 분산락

애플리케이션 instance가 여러 대일 때는 Redis 기반 분산락을 고려할 수 있다. Redisson을 사용하면 key 단위 lock을 비교적 쉽게 잡을 수 있다.

```java
RLock lock = redissonClient.getLock("product_lock:" + productId);

try {
    if (!lock.tryLock(5, 10, TimeUnit.SECONDS)) {
        throw new IllegalStateException("lock acquisition failed");
    }

    // 재고 감소와 주문 저장
} finally {
    if (lock.isHeldByCurrentThread()) {
        lock.unlock();
    }
}
```

여기서 `tryLock(5, 10, TimeUnit.SECONDS)`는 두 값을 가진다.

| 값 | 의미 |
| --- | --- |
| wait time | lock 획득을 기다리는 최대 시간 |
| lease time | lock을 잡은 뒤 유지되는 시간 |

lease time보다 비즈니스 로직이 오래 걸리면 lock이 먼저 풀릴 수 있다. 반대로 자동 연장을 쓰면 비정상적으로 오래 잡히는 상황도 고려해야 한다. 그래서 분산락은 lock 획득보다 해제, timeout, 재시도 기준이 더 중요하다.

## 선택 기준

세 방식을 이렇게 나눠 볼 수 있다.

| 방식 | 적합한 상황 | 주의점 |
| --- | --- | --- |
| 낙관적 락 | 충돌이 드물고 재시도가 가능한 요청 | 충돌이 몰리면 재시도 폭증 |
| 비관적 락 | 같은 row에 충돌이 잦고 DB에서 직렬화해야 하는 요청 | transaction 길이와 lock wait 관리 필요 |
| Redis 분산락 | 여러 instance에서 특정 key 작업을 하나만 실행해야 하는 요청 | Redis 장애, lease time, unlock 보장 필요 |

재고 차감처럼 DB row가 최종 source of truth라면 DB 제약과 transaction을 먼저 설계하고, Redis lock은 부하를 줄이거나 애플리케이션 단의 중복 실행을 줄이는 보조 수단으로 보는 편이 안전하다.

## 운영 기준

락을 적용할 때는 구현보다 관측 기준을 먼저 정해야 한다.

- lock wait time
- retry count
- timeout count
- transaction duration
- 실패 후 사용자 응답
- 재시도 가능 여부

특히 `@Retryable`은 예외가 발생해야 동작한다. Redisson `tryLock`은 lock 획득 실패 시 `false`를 반환하므로, 재시도를 원한다면 명시적으로 예외를 던져야 한다.

## 정리

락 선택은 기술 이름으로 결정하면 안 된다.

```text
충돌이 얼마나 자주 나는가?
실패 요청을 재시도해도 되는가?
최종 일관성 기준은 DB인가 Redis인가?
lock을 잡은 동안 무엇을 실행하는가?
```

이 질문에 답해야 낙관적 락, 비관적 락, 분산락 중 무엇을 쓸지 정할 수 있다.

원문: [lock 실습을 곁들인](https://velog.io/@kimgunwooo/lock-%EC%8B%A4%EC%8A%B5%EC%9D%84-%EA%B3%81%EB%93%A4%EC%9D%B8)
