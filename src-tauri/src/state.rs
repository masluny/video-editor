use crate::engine::timeline::Project;
use tokio::sync::Mutex;

pub struct AppState {
    pub project: Mutex<Project>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            project: Mutex::new(Project::default()),
        }
    }
}
