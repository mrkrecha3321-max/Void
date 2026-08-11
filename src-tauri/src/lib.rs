use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

mod android_updater;
mod crypto;
mod mesh;
mod native_bridge;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReceivedPayload {
    pub id: String,
    pub peer_id: String,
    pub text: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDiscoveredPayload {
    pub id: String,
    pub name: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatusPayload {
    pub id: String,
    pub online: bool,
}

pub struct AppState {
    pub node_id: String,
    pub peers: Mutex<Vec<Peer>>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn start_mesh(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mesh = app.state::<mesh::MeshState>();
    let name = mesh.node_name.lock().map_err(|e| e.to_string())?.clone();
    ble_init(state, mesh, name)?;
    ble_start_advertising()?;
    ble_start_scanning()?;
    Ok("BLE Mesh auto-started".to_string())
}

#[tauri::command]
fn add_peer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    name: String,
) -> Result<(), String> {
    let mut peers_guard = state.peers.lock().map_err(|e| e.to_string())?;

    if !peers_guard.iter().any(|p| p.id == peer_id) {
        let peer = Peer {
            id: peer_id.clone(),
            name: name.clone(),
            online: true,
            last_seen: None,
        };
        peers_guard.push(peer.clone());

        let _ = app.emit(
            "peer_discovered",
            PeerDiscoveredPayload {
                id: peer.id.clone(),
                name: peer.name.clone(),
                online: peer.online,
            },
        );

        let _ = app.emit(
            "peer_status",
            PeerStatusPayload {
                id: peer.id.clone(),
                online: peer.online,
            },
        );
    }

    let mesh = app.state::<mesh::MeshState>();
    if let Some(addr) = mesh.find_address_by_peer_id(&peer_id) {
        mesh::send_presence(&mesh, &addr);
    }

    Ok(())
}

#[tauri::command]
async fn trigger_panic_button() -> String {
    "PANIC_TRIGGERED".to_string()
}

#[tauri::command]
async fn check_for_updates() -> Result<String, String> {
    let repo = "mrkrecha3321-max/Void";
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);

    let client = reqwest::Client::builder()
        .user_agent("vortex-updater")
        .build()
        .map_err(|e| e.to_string())?;
        
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    
    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(tag_name) = json.get("tag_name").and_then(|v| v.as_str()) {
            return Ok(tag_name.to_string());
        }
    }
    
    Err("No updates found".into())
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let repo = "mrkrecha3321-max/Void";
    let url = format!("https://github.com/{}/releases/download/{}/Void.apk", repo, version);

    let client = reqwest::Client::builder()
        .user_agent("vortex-updater")
        .build()
        .map_err(|e| e.to_string())?;
        
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    
    let cache_dir = app.path().cache_dir().map_err(|_| "No cache dir".to_string())?;
    let apk_path = cache_dir.join("update.apk");
    
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(&apk_path, bytes).map_err(|e| e.to_string())?;
    
    android_updater::install_apk_jni(&app, apk_path.to_string_lossy().to_string())
}

#[tauri::command]
fn send_message(app_handle: tauri::AppHandle, peer_id: String, text: String) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let payload = MessageReceivedPayload {
        id: format!("msg-{}", now),
        peer_id,
        text,
        timestamp: format!("{}", now),
    };

    let _ = app_handle.emit("message_received", payload);
}

#[tauri::command]
fn get_peers(state: State<'_, AppState>) -> Vec<Peer> {
    state.peers.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
fn get_node_id(state: State<'_, AppState>) -> String {
    state.node_id.clone()
}

#[tauri::command]
fn get_connected_addresses(mesh: State<'_, mesh::MeshState>) -> Vec<String> {
    mesh.get_connected_addresses()
}

// ---- Prawdziwe BLE (advertise + scan + GATT) przez most JNI do Kotlina ----

#[tauri::command]
fn ble_init(state: State<'_, AppState>, mesh: State<'_, mesh::MeshState>, name: String) -> Result<(), String> {
    *mesh.node_name.lock().map_err(|e| e.to_string())? = name.clone();
    native_bridge::calls::init(&state.node_id, &name)
}

#[tauri::command]
fn mesh_get_public_key(mesh: State<'_, mesh::MeshState>) -> String {
    crypto::public_b64(&mesh.public)
}

#[tauri::command]
fn mesh_send_text(mesh: State<'_, mesh::MeshState>, recipient_id: String, text: String) -> Result<String, String> {
    mesh::send_text(&mesh, &recipient_id, &text)
}

#[tauri::command]
fn mesh_send_location(mesh: State<'_, mesh::MeshState>, recipient_id: String, lat: f64, lon: f64) -> Result<String, String> {
    mesh::send_location(&mesh, &recipient_id, lat, lon)
}

#[tauri::command]
fn ble_start_advertising() -> Result<bool, String> {
    native_bridge::calls::start_advertising()
}

#[tauri::command]
fn ble_start_scanning() -> Result<bool, String> {
    native_bridge::calls::start_scanning()
}

#[tauri::command]
fn ble_stop_scanning() -> Result<(), String> {
    native_bridge::calls::stop_scanning()
}

#[tauri::command]
fn ble_send_message(address: String, text: String) -> Result<bool, String> {
    native_bridge::calls::send_message(&address, &text)
}

#[tauri::command]
fn ble_connect_to_peer(address: String) -> Result<bool, String> {
    native_bridge::calls::connect_to_peer(&address)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            native_bridge::set_app_handle(app.handle().clone());

            let identity_path = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join("identity.json");
            let identity = crypto::load_or_create(&identity_path);
            let node_id = crypto::node_id_from_public(&identity.public);

            app.manage(mesh::MeshState::new(identity.secret, identity.public, node_id.clone()));

            app.manage(AppState {
                node_id,
                peers: Mutex::new(Vec::new()),
            });
            Ok(())
        });

    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .invoke_handler(tauri::generate_handler![
            greet,
            start_mesh,
            add_peer,
            trigger_panic_button,
            check_for_updates,
            install_update,
            send_message,
            get_peers,
            get_node_id,
            ble_init,
            ble_start_advertising,
            ble_start_scanning,
            ble_stop_scanning,
            ble_send_message,
            ble_connect_to_peer,
            mesh_get_public_key,
            mesh_send_text,
            mesh_send_location,
            get_connected_addresses
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

