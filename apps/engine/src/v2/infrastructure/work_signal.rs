//! 작업 루프를 깨우는 신호 구현.
//!
//! - MongoDB: `v2_engine_jobs` change stream으로 새 작업을 알린다 (replica set 필요)
//! - 그 밖(PostgreSQL, 단독 MongoDB): 주기 확인만 한다. PostgreSQL은 이후 `LISTEN/NOTIFY` 구현을 이 자리에 넣는다

use crate::v2::ports::WorkSignalPort;
use async_trait::async_trait;
use futures_util::StreamExt;
use mongodb::bson::{doc, Document};
use mongodb::Database;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

/// 신호 없이 주기 확인만 한다. 알림을 쓸 수 없는 환경의 기본값이다.
pub struct PollingWorkSignal;

#[async_trait]
impl WorkSignalPort for PollingWorkSignal {
    async fn wait_for_work(&self, timeout: Duration) {
        tokio::time::sleep(timeout).await;
    }
}

/// MongoDB change stream으로 새 작업을 알린다.
///
/// 새 작업 추가(insert)와 작업을 다시 대기(QUEUED)로 돌린 경우만 신호로 받는다.
/// 엔진이 작업을 RUNNING·COMPLETED로 바꾸는 기록은 걸러서 스스로 깨어나지 않게 한다.
/// 스트림이 끊기면 다시 연결하고, 그동안은 주기 확인으로 동작한다.
pub struct MongoChangeStreamWorkSignal {
    notify: Arc<Notify>,
}

impl MongoChangeStreamWorkSignal {
    pub fn start(db: Database) -> Self {
        let notify = Arc::new(Notify::new());
        let sender = notify.clone();
        tokio::spawn(async move {
            let jobs = db.collection::<Document>("v2_engine_jobs");
            let pipeline = vec![doc! {
                "$match": {
                    "$or": [
                        { "operationType": "insert" },
                        { "operationType": "update", "updateDescription.updatedFields.status": "QUEUED" },
                    ]
                }
            }];
            let mut backoff = Duration::from_secs(1);
            loop {
                match jobs.watch(pipeline.clone(), None).await {
                    Ok(mut stream) => {
                        println!("[engine] work signal: change stream opened on v2_engine_jobs");
                        backoff = Duration::from_secs(1);
                        // 스트림을 여는 사이에 들어온 작업을 놓치지 않도록 한 번 깨운다.
                        sender.notify_one();
                        while let Some(event) = stream.next().await {
                            match event {
                                Ok(_) => sender.notify_one(),
                                Err(error) => {
                                    eprintln!("[engine] work signal: change stream error: {error}");
                                    break;
                                }
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!("[engine] work signal: cannot open change stream ({error}); polling only until retry");
                    }
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        });
        Self { notify }
    }
}

#[async_trait]
impl WorkSignalPort for MongoChangeStreamWorkSignal {
    async fn wait_for_work(&self, timeout: Duration) {
        // notify_one은 기다리는 쪽이 없으면 신호를 하나 보관한다.
        // 작업을 처리하는 동안 들어온 신호도 다음 대기에서 바로 받는다.
        tokio::select! {
            _ = tokio::time::sleep(timeout) => {}
            _ = self.notify.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn polling_signal_waits_for_the_timeout() {
        let started = std::time::Instant::now();
        PollingWorkSignal.wait_for_work(Duration::from_millis(30)).await;
        assert!(started.elapsed() >= Duration::from_millis(30));
    }

    #[tokio::test]
    async fn a_signal_sent_while_busy_wakes_the_next_wait_immediately() {
        let signal = MongoChangeStreamWorkSignal { notify: Arc::new(Notify::new()) };
        signal.notify.notify_one();
        let started = std::time::Instant::now();
        signal.wait_for_work(Duration::from_secs(5)).await;
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn without_a_signal_the_wait_falls_back_to_the_timeout() {
        let signal = MongoChangeStreamWorkSignal { notify: Arc::new(Notify::new()) };
        let started = std::time::Instant::now();
        signal.wait_for_work(Duration::from_millis(30)).await;
        assert!(started.elapsed() >= Duration::from_millis(30));
    }
}
