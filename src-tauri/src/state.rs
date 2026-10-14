use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Default)]
pub struct AppState {
    /// Running exports: job id -> cancel switch.
    pub exports: Mutex<HashMap<String, watch::Sender<bool>>>,
    /// One lock per media path so concurrent proxy requests don't collide.
    pub proxy_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl AppState {
    pub fn proxy_lock(&self, path: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.proxy_locks.lock().unwrap().entry(path.to_string()).or_default().clone()
    }
}
