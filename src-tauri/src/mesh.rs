// Multi-hop routing (flooding, TTL max 32) + integracja z E2EE (crypto.rs).
// Wezly posredniczace widza tylko zaszyfrowany blob - nie tresc wiadomosci.

use crate::crypto;
use crate::native_bridge;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use x25519_dalek::{PublicKey, StaticSecret};

pub const MAX_TTL: u8 = 32;
const SEEN_CACHE_CAP: usize = 500;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    pub address: String,
    pub short_id: String,
    pub name: String,
    pub rssi: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeshEnvelope {
    msg_id: String,
    msg_type: String, // "text" | "presence" | "ack" | "location"
    sender_id: String,
    sender_pubkey: String,
    recipient_id: String, // "*" dla presence
    ttl: u8,
    ciphertext: Option<String>,
    nonce: Option<String>,
    plain_presence_name: Option<String>,
    // For location messages, payload will be encrypted in ciphertext,
    // but for simple ack, we can just put original msg_id in a new field or use ciphertext.
    // Let's use an explicit field for ACK to avoid encryption overhead for simple delivery receipts.
    ack_msg_id: Option<String>,
}

pub struct MeshState {
    pub identity: StaticSecret,
    pub public: PublicKey,
    pub node_id: String,
    pub node_name: Mutex<String>,
    pub known_pubkeys: Mutex<HashMap<String, PublicKey>>,
    pub connected_addresses: Mutex<HashSet<String>>,
    pub discovered_peers: Mutex<HashMap<String, DiscoveredPeer>>,
    seen_ids: Mutex<VecDeque<String>>,
    seen_set: Mutex<HashSet<String>>,
}

impl MeshState {
    pub fn new(identity: StaticSecret, public: PublicKey, node_id: String) -> Self {
        Self {
            identity,
            public,
            node_id,
            node_name: Mutex::new("Vortex".to_string()),
            known_pubkeys: Mutex::new(HashMap::new()),
            connected_addresses: Mutex::new(HashSet::new()),
            discovered_peers: Mutex::new(HashMap::new()),
            seen_ids: Mutex::new(VecDeque::new()),
            seen_set: Mutex::new(HashSet::new()),
        }
    }

    fn mark_seen(&self, id: &str) -> bool {
        let mut set = self.seen_set.lock().unwrap_or_else(|e| e.into_inner());
        if set.contains(id) {
            return false;
        }
        set.insert(id.to_string());
        let mut queue = self.seen_ids.lock().unwrap_or_else(|e| e.into_inner());
        queue.push_back(id.to_string());
        if queue.len() > SEEN_CACHE_CAP {
            if let Some(old) = queue.pop_front() {
                set.remove(&old);
            }
        }
        true
    }

    pub fn mark_connected(&self, address: &str) {
        self.connected_addresses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(address.to_string());
    }

    pub fn mark_disconnected(&self, address: &str) {
        self.connected_addresses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(address);
    }

    pub fn get_connected_addresses(&self) -> Vec<String> {
        self.connected_addresses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    #[allow(dead_code)]
    pub fn record_discovered_peer(&self, address: &str, short_id: &str, name: &str, rssi: i32) {
        let mut map = self.discovered_peers.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, peer| peer.short_id != short_id || peer.address == address);
        map.insert(
            address.to_string(),
            DiscoveredPeer {
                address: address.to_string(),
                short_id: short_id.to_string(),
                name: name.to_string(),
                rssi,
            },
        );
    }

    #[allow(dead_code)]
    pub fn is_connected(&self, address: &str) -> bool {
        self.connected_addresses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(address)
    }

    pub fn find_address_by_peer_id(&self, peer_id: &str) -> Option<String> {
        let map = self.discovered_peers.lock().unwrap_or_else(|e| e.into_inner());
        for (addr, peer) in map.iter() {
            if peer.short_id == peer_id || peer.address == peer_id || peer_id.ends_with(&peer.short_id) {
                return Some(addr.clone());
            }
        }
        None
    }
}

fn relay(state: &MeshState, envelope: &MeshEnvelope, exclude_address: Option<&str>) {
    let json = serde_json::to_string(envelope).unwrap_or_default();
    let addresses: Vec<String> = state
        .connected_addresses
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|a| Some(a.as_str()) != exclude_address)
        .cloned()
        .collect();
    for addr in addresses {
        let _ = native_bridge::calls::send_message(&addr, &json);
    }
}

/// Wysylane od razu po nawiazaniu bezposredniego polaczenia BLE - zeby sasiad poznal
/// nasz node_id + klucz publiczny (potrzebne pozniej do szyfrowania do nas).
#[allow(dead_code)]
pub fn send_presence(state: &MeshState, to_address: &str) {
    let envelope = MeshEnvelope {
        msg_id: uuid::Uuid::new_v4().to_string(),
        msg_type: "presence".into(),
        sender_id: state.node_id.clone(),
        sender_pubkey: crypto::public_b64(&state.public),
        recipient_id: "*".into(),
        ttl: 1,
        ciphertext: None,
        nonce: None,
        plain_presence_name: Some(
            state
                .node_name
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        ),
        ack_msg_id: None,
    };
    let json = serde_json::to_string(&envelope).unwrap_or_default();
    let _ = native_bridge::calls::send_message(to_address, &json);
}

pub fn send_text(state: &MeshState, recipient_id: &str, text: &str) -> Result<String, String> {
    let pubkey = {
        let map = state.known_pubkeys.lock().map_err(|e| e.to_string())?;
        map.get(recipient_id).cloned()
    };
    let pubkey = pubkey.ok_or_else(|| {
        "Nieznany klucz publiczny odbiorcy - musicie byc byli chocby raz bezposrednio w zasiegu".to_string()
    })?;
    let (ciphertext, nonce) = crypto::encrypt(&state.identity, &pubkey, text);
    let envelope = MeshEnvelope {
        msg_id: uuid::Uuid::new_v4().to_string(),
        msg_type: "text".into(),
        sender_id: state.node_id.clone(),
        sender_pubkey: crypto::public_b64(&state.public),
        recipient_id: recipient_id.to_string(),
        ttl: MAX_TTL,
        ciphertext: Some(ciphertext),
        nonce: Some(nonce),
        plain_presence_name: None,
        ack_msg_id: None,
    };
    state.mark_seen(&envelope.msg_id);
    relay(state, &envelope, None);
    Ok(envelope.msg_id.clone())
}

pub fn send_location(state: &MeshState, recipient_id: &str, lat: f64, lon: f64) -> Result<String, String> {
    let pubkey = {
        let map = state.known_pubkeys.lock().map_err(|e| e.to_string())?;
        map.get(recipient_id).cloned()
    };
    let pubkey = pubkey.ok_or_else(|| {
        "Nieznany klucz publiczny odbiorcy".to_string()
    })?;
    let payload = format!("{},{}", lat, lon);
    let (ciphertext, nonce) = crypto::encrypt(&state.identity, &pubkey, &payload);
    let envelope = MeshEnvelope {
        msg_id: uuid::Uuid::new_v4().to_string(),
        msg_type: "location".into(),
        sender_id: state.node_id.clone(),
        sender_pubkey: crypto::public_b64(&state.public),
        recipient_id: recipient_id.to_string(),
        ttl: 4, // smaller TTL for location updates to reduce mesh flood
        ciphertext: Some(ciphertext),
        nonce: Some(nonce),
        plain_presence_name: None,
        ack_msg_id: None,
    };
    state.mark_seen(&envelope.msg_id);
    relay(state, &envelope, None);
    Ok(envelope.msg_id.clone())
}

pub fn send_ack(state: &MeshState, recipient_id: &str, ack_for_msg_id: &str) {
    let envelope = MeshEnvelope {
        msg_id: uuid::Uuid::new_v4().to_string(),
        msg_type: "ack".into(),
        sender_id: state.node_id.clone(),
        sender_pubkey: crypto::public_b64(&state.public),
        recipient_id: recipient_id.to_string(),
        ttl: MAX_TTL,
        ciphertext: None,
        nonce: None,
        plain_presence_name: None,
        ack_msg_id: Some(ack_for_msg_id.to_string()),
    };
    state.mark_seen(&envelope.msg_id);
    relay(state, &envelope, None);
}

#[allow(dead_code)]
pub fn handle_incoming(app: &AppHandle, state: &MeshState, from_address: &str, raw_json: &str) {
    let envelope: MeshEnvelope = match serde_json::from_str(raw_json) {
        Ok(e) => e,
        Err(_) => return,
    };

    if !state.mark_seen(&envelope.msg_id) {
        return; // juz widziane - zapobiega petlom w sieci
    }

    if let Some(pk) = crypto::parse_public(&envelope.sender_pubkey) {
        state
            .known_pubkeys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(envelope.sender_id.clone(), pk);
    }

    match envelope.msg_type.as_str() {
        "presence" => {
            let sender_name = envelope
                .plain_presence_name
                .clone()
                .unwrap_or_else(|| envelope.sender_id.clone());

            // Mark sender's BLE address as connected (we just received a packet from them)
            state.mark_connected(from_address);

            let app_state = app.state::<crate::AppState>();
            let mut peers_guard = app_state.peers.lock().unwrap_or_else(|e| e.into_inner());
            let already_known = peers_guard.iter().any(|p| p.id == envelope.sender_id);
            if !already_known {
                peers_guard.push(crate::Peer {
                    id: envelope.sender_id.clone(),
                    name: sender_name.clone(),
                    online: true,
                    last_seen: None,
                });
            }
            drop(peers_guard); // release lock before emitting

            let _ = app.emit(
                "peer_discovered",
                serde_json::json!({
                    "id": envelope.sender_id,
                    "name": sender_name,
                    "online": true
                }),
            );

            let _ = app.emit(
                "peer_status",
                serde_json::json!({
                    "id": envelope.sender_id,
                    "online": true
                }),
            );

            // Reply with our own presence so the remote side gets our public key too.
            // Only reply if this is a NEW peer (not already known) to avoid an echo storm:
            //   First time: B sends presence → A receives → A replies with own presence ✅
            //   Already known: skip reply — both sides already have each other's keys ✅
            if !already_known {
                send_presence(state, from_address);
            }

            return; // ttl=1, nie relayowac dalej
        }
        "text" => {
            if envelope.recipient_id == state.node_id {
                if let (Some(ct), Some(nonce)) = (&envelope.ciphertext, &envelope.nonce) {
                    if let Some(sender_pk) = crypto::parse_public(&envelope.sender_pubkey) {
                        if let Some(text) = crypto::decrypt(&state.identity, &sender_pk, ct, nonce) {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis();
                            let _ = app.emit(
                                "message_received",
                                serde_json::json!({
                                    "id": envelope.msg_id.clone(),
                                    "peerId": envelope.sender_id,
                                    "text": text,
                                    "timestamp": format!("{}", now)
                                }),
                            );
                            
                            // Send ACK back
                            send_ack(state, &envelope.sender_id, &envelope.msg_id);
                        }
                    }
                }
                return; // jestesmy celem - koniec trasy, nie relayowac dalej
            }
        }
        "ack" => {
            if envelope.recipient_id == state.node_id {
                if let Some(ack_id) = &envelope.ack_msg_id {
                    let _ = app.emit(
                        "message_ack_received",
                        serde_json::json!({
                            "msgId": ack_id,
                            "peerId": envelope.sender_id,
                        }),
                    );
                }
                return;
            }
        }
        "location" => {
            if envelope.recipient_id == state.node_id {
                if let (Some(ct), Some(nonce)) = (&envelope.ciphertext, &envelope.nonce) {
                    if let Some(sender_pk) = crypto::parse_public(&envelope.sender_pubkey) {
                        if let Some(payload) = crypto::decrypt(&state.identity, &sender_pk, ct, nonce) {
                            // payload is lat,lon
                            let parts: Vec<&str> = payload.split(',').collect();
                            if parts.len() == 2 {
                                if let (Ok(lat), Ok(lon)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                                    let _ = app.emit(
                                        "peer_location_received",
                                        serde_json::json!({
                                            "peerId": envelope.sender_id,
                                            "lat": lat,
                                            "lon": lon,
                                            "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
                                        })
                                    );
                                }
                            }
                        }
                    }
                }
                return;
            }
        }
        _ => return,
    }

    if envelope.ttl > 0 {
        let mut forwarded = envelope.clone();
        forwarded.ttl -= 1;
        relay(state, &forwarded, Some(from_address));
    }
}

