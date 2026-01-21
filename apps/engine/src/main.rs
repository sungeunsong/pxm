#[tokio::main]
async fn main() {
    println!("bpm-engine boot ✅");
    loop {
        // TODO: engine_jobs SKIP LOCKED fetch + process
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        println!("engine tick");
    }
}
