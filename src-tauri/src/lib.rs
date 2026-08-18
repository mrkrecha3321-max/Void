#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

mod android_updater;
mod backup;
mod crypto;
mod mesh;
mod native_bridge;
mod reliability;
mod storage;

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
    pub identity_path: PathBuf,
    pub secure_store: Arc<storage::SecureStore>,
}

fn validate_display_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err("Nazwa musi miec od 1 do 80 bajtow".to_string());
    }
    Ok(name.to_string())
}

#[tauri::command]
async fn start_mesh(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let mesh = app.state::<mesh::MeshState>();
    let name = mesh.node_name.lock().map_err(|e| e.to_string())?.clone();
    let settings = mesh.settings.lock().map_err(|e| e.to_string())?.clone();
    ble_init(state, mesh, name)?;
    native_bridge::calls::ensure_mesh_service()?;
    native_bridge::calls::update_settings(settings.hide_node, settings.battery_save)?;
    if !ble_start_advertising()? {
        return Err("Nie udalo sie uruchomic BLE advertising".to_string());
    }
    if !ble_start_scanning()? {
        return Err("Nie udalo sie uruchomic skanowania BLE".to_string());
    }
    native_bridge::calls::set_rust_ready()?;
    Ok("BLE Mesh uruchomiony".to_string())
}

#[tauri::command]
fn add_peer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    name: String,
) -> Result<(), String> {
    if !crypto::is_valid_node_id(&peer_id) || peer_id == state.node_id {
        return Err("Nieprawidlowy Node ID peera".to_string());
    }
    let name = validate_display_name(&name)?;
    let mut peers = state.peers.lock().map_err(|e| e.to_string())?;
    if peers.len() >= 2_048 && !peers.iter().any(|peer| peer.id == peer_id) {
        return Err("Osiagnieto limit zapisanych peerow".to_string());
    }
    if !peers.iter().any(|peer| peer.id == peer_id) {
        let peer = Peer {
            id: peer_id.clone(),
            name: name.clone(),
            // Manual addition is not proof of connectivity.
            online: false,
            last_seen: None,
        };
        peers.push(peer.clone());
        let _ = app.emit(
            "peer_discovered",
            PeerDiscoveredPayload {
                id: peer.id,
                name: peer.name,
                online: false,
            },
        );
    }
    drop(peers);

    let mesh = app.state::<mesh::MeshState>();
    state.secure_store.add_contact(&peer_id, &name)?;
    mesh.trust_peer(&peer_id)?;
    if let Some(address) = mesh.find_address_by_peer_id(&peer_id) {
        let _ = mesh::send_presence(&mesh, &address);
    }
    Ok(())
}

#[tauri::command]
fn set_node_name(
    state: State<'_, AppState>,
    mesh: State<'_, mesh::MeshState>,
    name: String,
) -> Result<(), String> {
    let name = validate_display_name(&name)?;
    *mesh.node_name.lock().map_err(|e| e.to_string())? = name.clone();
    native_bridge::calls::init(&state.node_id, &name)
}

#[tauri::command]
fn get_mesh_settings(mesh: State<'_, mesh::MeshState>) -> storage::CoreSettings {
    mesh.settings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
fn set_mesh_settings(
    mesh: State<'_, mesh::MeshState>,
    settings: storage::CoreSettings,
) -> Result<(), String> {
    native_bridge::calls::update_settings(settings.hide_node, settings.battery_save)?;
    mesh.update_settings(settings)
}

#[tauri::command]
fn trust_peer(mesh: State<'_, mesh::MeshState>, peer_id: String) -> Result<(), String> {
    if !crypto::is_valid_node_id(&peer_id) {
        return Err("Nieprawidlowy Node ID".to_string());
    }
    mesh.trust_peer(&peer_id)
}

#[tauri::command]
fn get_contact_card(mesh: State<'_, mesh::MeshState>) -> Result<String, String> {
    mesh::create_contact_card(&mesh)
}

#[tauri::command]
fn import_contact_card(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mesh: State<'_, mesh::MeshState>,
    card: String,
) -> Result<mesh::ContactCardInfo, String> {
    let info = mesh::import_contact_card(&mesh, &card)?;
    if info.node_id == state.node_id {
        return Err("Nie mozna dodac wlasnej wizytowki".to_string());
    }
    let mut peers = state.peers.lock().map_err(|e| e.to_string())?;
    if let Some(peer) = peers.iter_mut().find(|peer| peer.id == info.node_id) {
        peer.name = info.name.clone();
    } else if peers.len() < 2_048 {
        peers.push(Peer {
            id: info.node_id.clone(),
            name: info.name.clone(),
            online: false,
            last_seen: None,
        });
    } else {
        return Err("Osiagnieto limit kontaktow".to_string());
    }
    drop(peers);
    let _ = app.emit(
        "peer_discovered",
        PeerDiscoveredPayload {
            id: info.node_id.clone(),
            name: info.name.clone(),
            online: false,
        },
    );
    Ok(info)
}

#[tauri::command]
fn load_chat_state(state: State<'_, AppState>) -> serde_json::Value {
    state.secure_store.chat_state()
}

#[tauri::command]
fn save_chat_state(
    state: State<'_, AppState>,
    chat_state: serde_json::Value,
) -> Result<(), String> {
    state.secure_store.save_chat_state(chat_state)
}

#[tauri::command]
async fn export_identity_backup(
    mesh: State<'_, mesh::MeshState>,
    password: String,
) -> Result<String, String> {
    let identity = crypto::Identity {
        encryption_secret: mesh.identity.clone(),
        encryption_public: mesh.public,
        signing_secret: mesh.signing_identity.clone(),
        signing_public: mesh.signing_identity.verifying_key(),
    };
    tauri::async_runtime::spawn_blocking(move || backup::export_identity(&identity, &password))
        .await
        .map_err(|e| format!("Watek eksportu kopii zakonczyl sie bledem: {e}"))?
}

#[tauri::command]
async fn import_identity_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    backup_json: String,
    password: String,
) -> Result<(), String> {
    let identity = tauri::async_runtime::spawn_blocking(move || {
        backup::import_identity(&backup_json, &password)
    })
    .await
    .map_err(|e| format!("Watek importu kopii zakonczyl sie bledem: {e}"))??;
    // Vault encryption is identity-bound. Import intentionally clears local
    // peer pins/history; they can be rebuilt after the restored identity starts.
    state.secure_store.destroy()?;
    crypto::write_identity(&state.identity_path, &identity)?;
    let app_to_exit = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(750));
        app_to_exit.exit(0);
    });
    Ok(())
}

#[tauri::command]
async fn trigger_panic_button(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mesh: State<'_, mesh::MeshState>,
) -> Result<(), String> {
    crypto::destroy_identity(&state.identity_path)?;
    state.secure_store.destroy()?;
    mesh.clear_sensitive_state();
    state.peers.lock().map_err(|e| e.to_string())?.clear();
    let _ = app.emit("panic_wipe_completed", serde_json::json!({ "ok": true }));

    // Give the command response and frontend storage cleanup a short moment to
    // complete. Process termination then removes the old private keys from RAM.
    let app_to_exit = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(750));
        app_to_exit.exit(0);
    });
    Ok(())
}

#[tauri::command]
async fn check_for_updates() -> Result<String, String> {
    let url = "https://api.github.com/repos/mrkrecha3321-max/Void/releases/latest";
    let client = reqwest::Client::builder()
        .user_agent("void-updater")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("GitHub update check failed: {e}"))?;
    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    json.get("tag_name")
        .and_then(|value| value.as_str())
        .filter(|tag| android_updater::is_valid_release_tag(tag))
        .map(str::to_string)
        .ok_or_else(|| "Release nie zawiera prawidlowego tagu wersji".to_string())
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    android_updater::download_and_install(&app, &version).await
}

#[tauri::command]
fn get_peers(state: State<'_, AppState>) -> Vec<Peer> {
    state
        .peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
fn get_node_id(state: State<'_, AppState>) -> String {
    state.node_id.clone()
}

#[tauri::command]
fn get_connected_addresses(mesh: State<'_, mesh::MeshState>) -> Vec<String> {
    mesh.get_connected_addresses()
}

#[tauri::command]
fn ble_init(
    state: State<'_, AppState>,
    mesh: State<'_, mesh::MeshState>,
    name: String,
) -> Result<(), String> {
    let name = validate_display_name(&name)?;
    *mesh.node_name.lock().map_err(|e| e.to_string())? = name.clone();
    native_bridge::calls::init(&state.node_id, &name)
}

#[tauri::command]
fn mesh_get_public_key(mesh: State<'_, mesh::MeshState>) -> String {
    crypto::encryption_public_b64(&mesh.public)
}

#[tauri::command]
fn mesh_send_text(
    mesh: State<'_, mesh::MeshState>,
    recipient_id: String,
    text: String,
) -> Result<mesh::SendResult, String> {
    mesh::send_text(&mesh, &recipient_id, &text)
}

#[tauri::command]
fn mesh_send_location(
    mesh: State<'_, mesh::MeshState>,
    recipient_id: String,
    lat: f64,
    lon: f64,
) -> Result<String, String> {
    mesh::send_location(&mesh, &recipient_id, lat, lon)
}

#[tauri::command]
fn mesh_flush_outbox(app: tauri::AppHandle, mesh: State<'_, mesh::MeshState>) {
    mesh::flush_outbox(&app, &mesh);
}

#[tauri::command]
fn mesh_retry_message(mesh: State<'_, mesh::MeshState>, msg_id: String) -> Result<String, String> {
    if msg_id.is_empty() || msg_id.len() > 64 {
        return Err("Nieprawidlowy identyfikator wiadomosci".to_string());
    }
    mesh::retry_outbox_item(&mesh, &msg_id)
}

#[tauri::command]
fn list_pending_inbox(mesh: State<'_, mesh::MeshState>) -> Vec<mesh::InboxMessage> {
    mesh::list_pending_inbox(&mesh)
}

#[tauri::command]
fn confirm_inbox(
    mesh: State<'_, mesh::MeshState>,
    ids: Vec<String>,
) -> Result<Vec<String>, String> {
    mesh::confirm_inbox(&mesh, ids)
}

#[tauri::command]
fn mesh_send_sos(
    mesh: State<'_, mesh::MeshState>,
    name: String,
    description: String,
    lat: Option<f64>,
    lon: Option<f64>,
) -> Result<String, String> {
    mesh::send_sos(&mesh, name, description, lat, lon)
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
fn ble_send_message(address: String, text: String, msg_id: String) -> Result<bool, String> {
    if address.len() > 32
        || text.len() > mesh::MAX_ENVELOPE_BYTES
        || msg_id.is_empty()
        || msg_id.len() > 64
    {
        return Err("Nieprawidlowy rozmiar danych BLE".to_string());
    }
    native_bridge::calls::send_message(&address, &text, &msg_id)
}

#[tauri::command]
fn ble_connect_to_peer(address: String) -> Result<bool, String> {
    if address.is_empty() || address.len() > 32 {
        return Err("Nieprawidlowy adres BLE".to_string());
    }
    native_bridge::calls::connect_to_peer(&address)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            native_bridge::set_app_handle(app.handle().clone());
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let identity_path = app_data_dir.join("identity.json");
            let identity = crypto::load_or_create(&identity_path).map_err(std::io::Error::other)?;
            let node_id = crypto::node_id_from_signing_public(&identity.signing_public);
            let storage_key =
                crypto::derive_storage_key(&identity).map_err(std::io::Error::other)?;
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let secure_store = Arc::new(
                storage::SecureStore::open(
                    app_data_dir.join("vault-v2.json"),
                    storage_key,
                    timestamp,
                )
                .map_err(std::io::Error::other)?,
            );
            let mut persisted_peer_map: std::collections::HashMap<String, Peer> = secure_store
                .contacts()
                .into_iter()
                .map(|(id, name)| {
                    (
                        id.clone(),
                        Peer {
                            id,
                            name,
                            online: false,
                            last_seen: None,
                        },
                    )
                })
                .collect();
            for pin in secure_store.peer_pins() {
                persisted_peer_map.insert(
                    pin.node_id.clone(),
                    Peer {
                        id: pin.node_id,
                        name: pin.name,
                        online: false,
                        last_seen: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
                            pin.updated_at_ms as i64,
                        )
                        .map(|timestamp| timestamp.to_rfc3339()),
                    },
                );
            }
            let persisted_peers = persisted_peer_map.into_values().collect();
            app.manage(mesh::MeshState::new(
                identity.encryption_secret,
                identity.encryption_public,
                identity.signing_secret,
                node_id.clone(),
                secure_store.clone(),
            ));
            app.manage(AppState {
                node_id,
                peers: Mutex::new(persisted_peers),
                identity_path,
                secure_store,
            });
            Ok(())
        });

    builder
        .invoke_handler(tauri::generate_handler![
            start_mesh,
            add_peer,
            set_node_name,
            get_mesh_settings,
            set_mesh_settings,
            trust_peer,
            get_contact_card,
            import_contact_card,
            load_chat_state,
            save_chat_state,
            export_identity_backup,
            import_identity_backup,
            trigger_panic_button,
            check_for_updates,
            install_update,
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
            mesh_flush_outbox,
            mesh_retry_message,
            list_pending_inbox,
            confirm_inbox,
            mesh_send_sos,
            get_connected_addresses
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
