use crate::engine::timeline::Project;
use crate::state::AppState;
use anyhow::Result;

#[tauri::command]
pub async fn get_project(
    state: tauri::State<'_, AppState>,
) -> Result<Project, String> {
    let project = state.project.lock().await;
    Ok(project.clone())
}

#[tauri::command]
pub async fn update_project(
    state: tauri::State<'_, AppState>,
    project: Project,
) -> Result<(), String> {
    let mut p = state.project.lock().await;
    *p = project;
    Ok(())
}

#[tauri::command]
pub async fn save_project(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let project = state.project.lock().await;
    let json = serde_json::to_string_pretty(&*project)
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_project(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Project, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())?;
    let project: Project = serde_json::from_str(&content)
        .map_err(|e| e.to_string())?;
    let mut p = state.project.lock().await;
    *p = project.clone();
    Ok(project)
}
