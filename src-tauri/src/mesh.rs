use crate::crypto;
use crate::native_bridge;
use crate::storage::{CoreSettings, OutboxRecord, PeerPinRecord, SecureStore};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use x25519_dalek::{PublicKey, StaticSecret};

pub const PROTOCOL_VERSION: u8 = 2;
pub const MAX_TTL: u8 = 32;
pub const MAX_ENVELOPE_BYTES: usize = 4_080;
pub const MAX_TEXT_BYTES: usize = 2_048;
const MAX_NAME_BYTES: usize = 80;
const MAX_DESCRIPTION_BYTES: usize = 200;
const MAX_STATE_PEERS: usize = 2_048;
const SEEN_CACHE_CAP: usize = 10_000;
const MESSAGE_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const FUTURE_CLOCK_SKEW_MS: u64 = 5 * 60 * 1_000;
const RATE_WINDOW_MS: u64 = 10_000;
const MAX_MESSAGES_PER_WINDOW: usize = 40;
const SOS_COOLDOWN: Duration = Duration::from_secs(60);

trait MeshTransport: Send + Sync {
    fn send(&self, address: &str, payload: &str) -> Result<bool, String>;
}

struct NativeBleTransport;

impl MeshTransport for NativeBleTransport {
    fn send(&self, address: &str, payload: &str) -> Result<bool, String> {
        native_bridge::calls::send_message(address, payload)
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    pub address: String,
    pub short_id: String,
    pub full_id: Option<String>,
    pub name: String,
    pub rssi: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub msg_id: String,
    pub queued: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactCardBody {
    version: u8,
    node_id: String,
    name: String,
    signing_public_b64: String,
    encryption_public_b64: String,
    issued_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactCardEnvelope {
    body: ContactCardBody,
    signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactCardInfo {
    pub node_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SosPayload {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MeshEnvelopeBody {
    version: u8,
    msg_id: String,
    msg_type: String,
    sender_id: String,
    sender_encryption_pubkey: String,
    sender_signing_pubkey: String,
    recipient_id: String,
    created_at_ms: u64,
    max_hops: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ciphertext: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    presence_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ack_msg_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sos: Option<SosPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MeshEnvelope {
    body: MeshEnvelopeBody,
    hops_remaining: u8,
    signature: String,
}

struct ValidatedEnvelope {
    envelope: MeshEnvelope,
    sender_encryption_public: PublicKey,
    sender_signing_public_b64: String,
}

pub struct MeshState {
    pub identity: StaticSecret,
    pub public: PublicKey,
    pub signing_identity: SigningKey,
    pub node_id: String,
    pub node_name: Mutex<String>,
    pub known_pubkeys: Mutex<HashMap<String, PublicKey>>,
    pub connected_addresses: Mutex<HashSet<String>>,
    pub discovered_peers: Mutex<HashMap<String, DiscoveredPeer>>,
    pub settings: Mutex<CoreSettings>,
    pub store: Arc<SecureStore>,
    transport: Arc<dyn MeshTransport>,
    seen_ids: Mutex<VecDeque<String>>,
    seen_set: Mutex<HashSet<String>>,
    rate_limits: Mutex<HashMap<String, VecDeque<u64>>>,
    last_sos_sent: Mutex<Option<Instant>>,
    last_sos_received: Mutex<HashMap<String, Instant>>,
}

impl MeshState {
    pub fn new(
        identity: StaticSecret,
        public: PublicKey,
        signing_identity: SigningKey,
        node_id: String,
        store: Arc<SecureStore>,
    ) -> Self {
        Self::new_inner(
            identity,
            public,
            signing_identity,
            node_id,
            store,
            Arc::new(NativeBleTransport),
        )
    }

    fn new_inner(
        identity: StaticSecret,
        public: PublicKey,
        signing_identity: SigningKey,
        node_id: String,
        store: Arc<SecureStore>,
        transport: Arc<dyn MeshTransport>,
    ) -> Self {
        let mut known_pubkeys = HashMap::new();
        for pin in store.peer_pins() {
            let signing_matches = crypto::parse_signing_public(&pin.signing_public_b64)
                .is_some_and(|key| crypto::node_id_from_signing_public(&key) == pin.node_id);
            if signing_matches {
                if let Some(public) = crypto::parse_public(&pin.encryption_public_b64) {
                    known_pubkeys.insert(pin.node_id, public);
                }
            }
        }
        let replay_ids = store.replay_ids();
        let seen_set = replay_ids.iter().cloned().collect();
        Self {
            identity,
            public,
            signing_identity,
            node_id,
            node_name: Mutex::new("Void User".to_string()),
            known_pubkeys: Mutex::new(known_pubkeys),
            connected_addresses: Mutex::new(HashSet::new()),
            discovered_peers: Mutex::new(HashMap::new()),
            settings: Mutex::new(store.settings()),
            store,
            transport,
            seen_ids: Mutex::new(replay_ids.into()),
            seen_set: Mutex::new(seen_set),
            rate_limits: Mutex::new(HashMap::new()),
            last_sos_sent: Mutex::new(None),
            last_sos_received: Mutex::new(HashMap::new()),
        }
    }

    fn mark_seen(&self, id: &str, created_at_ms: u64) -> bool {
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
        drop(queue);
        drop(set);
        let _ = self.store.record_seen(id, created_at_ms);
        true
    }

    fn allow_incoming(&self, sender_id: &str, now_ms: u64) -> bool {
        let mut limits = self.rate_limits.lock().unwrap_or_else(|e| e.into_inner());
        if limits.len() >= MAX_STATE_PEERS && !limits.contains_key(sender_id) {
            return false;
        }
        let events = limits.entry(sender_id.to_string()).or_default();
        while events
            .front()
            .is_some_and(|timestamp| now_ms.saturating_sub(*timestamp) > RATE_WINDOW_MS)
        {
            events.pop_front();
        }
        if events.len() >= MAX_MESSAGES_PER_WINDOW {
            return false;
        }
        events.push_back(now_ms);
        true
    }

    fn remember_identity(
        &self,
        id: &str,
        public: PublicKey,
        signing_public_b64: &str,
        name: Option<&str>,
        updated_at_ms: u64,
    ) -> bool {
        let mut map = self.known_pubkeys.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_STATE_PEERS && !map.contains_key(id) {
            return false;
        }
        let existing = self.store.peer_pin(id);
        let pin = PeerPinRecord {
            node_id: id.to_string(),
            signing_public_b64: signing_public_b64.to_string(),
            encryption_public_b64: crypto::encryption_public_b64(&public),
            name: name
                .map(|value| truncate_utf8(value, MAX_NAME_BYTES))
                .or_else(|| existing.as_ref().map(|value| value.name.clone()))
                .unwrap_or_else(|| id.to_string()),
            trusted: existing.as_ref().is_some_and(|value| value.trusted),
            updated_at_ms,
        };
        let should_persist = existing.as_ref().is_none_or(|current| {
            current.signing_public_b64 != pin.signing_public_b64
                || current.encryption_public_b64 != pin.encryption_public_b64
                || name.is_some_and(|_| current.name != pin.name)
        });
        if should_persist && self.store.upsert_peer_pin(pin).is_err() {
            return false;
        }
        map.insert(id.to_string(), public);
        true
    }

    pub fn update_settings(&self, settings: CoreSettings) -> Result<(), String> {
        self.store.set_settings(settings.clone())?;
        *self.settings.lock().map_err(|e| e.to_string())? = settings;
        Ok(())
    }

    pub fn trust_peer(&self, node_id: &str) -> Result<(), String> {
        self.store.set_peer_trusted(node_id, true)
    }

    pub fn clear_sensitive_state(&self) {
        self.known_pubkeys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.seen_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.seen_set
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.rate_limits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
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

    pub fn record_discovered_peer(&self, address: &str, short_id: &str, name: &str, rssi: i32) {
        if address.len() > 32
            || short_id.len() != 8
            || !short_id.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return;
        }
        let mut map = self
            .discovered_peers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_STATE_PEERS && !map.contains_key(address) {
            return;
        }
        let existing = map.get(address).cloned();
        map.insert(
            address.to_string(),
            DiscoveredPeer {
                address: address.to_string(),
                short_id: short_id.to_ascii_uppercase(),
                full_id: existing.as_ref().and_then(|peer| peer.full_id.clone()),
                name: existing
                    .filter(|peer| peer.full_id.is_some())
                    .map(|peer| peer.name)
                    .unwrap_or_else(|| truncate_utf8(name.trim(), MAX_NAME_BYTES)),
                rssi,
            },
        );
    }

    pub fn bind_address_to_peer(&self, address: &str, node_id: &str, name: &str) {
        if let Some(peer) = self
            .discovered_peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(address)
        {
            peer.full_id = Some(node_id.to_string());
            peer.name = truncate_utf8(name, MAX_NAME_BYTES);
        }
    }

    pub fn peer_id_for_address(&self, address: &str) -> Option<String> {
        self.discovered_peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(address)
            .and_then(|peer| peer.full_id.clone())
    }

    pub fn find_address_by_peer_id(&self, peer_id: &str) -> Option<String> {
        let map = self
            .discovered_peers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let full_suffix = peer_id
            .strip_prefix("VX-")
            .filter(|hex| hex.len() == 32)
            .map(|hex| &hex[hex.len() - 8..]);
        if let Some((address, _)) = map.iter().find(|(address, peer)| {
            address.as_str() == peer_id || peer.full_id.as_deref() == Some(peer_id)
        }) {
            return Some(address.clone());
        }
        let suffix = full_suffix?;
        let mut candidates = map
            .iter()
            .filter(|(_, peer)| {
                peer.full_id.is_none() && suffix.eq_ignore_ascii_case(&peer.short_id)
            })
            .map(|(address, _)| address.clone());
        let candidate = candidates.next()?;
        if candidates.next().is_some() {
            None
        } else {
            Some(candidate)
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

pub fn create_contact_card(state: &MeshState) -> Result<String, String> {
    let name = state
        .node_name
        .lock()
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    let body = ContactCardBody {
        version: PROTOCOL_VERSION,
        node_id: state.node_id.clone(),
        name: truncate_utf8(&name, MAX_NAME_BYTES),
        signing_public_b64: crypto::signing_public_b64(&state.signing_identity.verifying_key()),
        encryption_public_b64: crypto::encryption_public_b64(&state.public),
        issued_at_ms: now_ms(),
    };
    let canonical = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    let envelope = ContactCardEnvelope {
        signature: crypto::sign(&state.signing_identity, &canonical),
        body,
    };
    let serialized = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    Ok(format!("VOID2:{}", URL_SAFE_NO_PAD.encode(serialized)))
}

pub fn import_contact_card(state: &MeshState, card: &str) -> Result<ContactCardInfo, String> {
    if card.len() > 2_048 || !card.starts_with("VOID2:") {
        return Err("Nieprawidlowy format wizytowki VOID".to_string());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(&card[6..])
        .map_err(|_| "Nieprawidlowe kodowanie wizytowki".to_string())?;
    let envelope: ContactCardEnvelope =
        serde_json::from_slice(&decoded).map_err(|_| "Nieprawidlowa wizytowka VOID".to_string())?;
    let body = &envelope.body;
    let current_time = now_ms();
    if body.version != PROTOCOL_VERSION
        || !crypto::is_valid_node_id(&body.node_id)
        || body.name.trim().is_empty()
        || body.name.len() > MAX_NAME_BYTES
        || body.issued_at_ms > current_time.saturating_add(FUTURE_CLOCK_SKEW_MS)
        || current_time.saturating_sub(body.issued_at_ms) > 365 * 24 * 60 * 60 * 1_000
    {
        return Err("Wizytowka VOID jest nieprawidlowa lub wygasla".to_string());
    }
    if body.node_id == state.node_id {
        return Err("Nie mozna importowac wlasnej wizytowki".to_string());
    }
    let signing_public = crypto::parse_signing_public(&body.signing_public_b64)
        .ok_or_else(|| "Wizytowka ma nieprawidlowy klucz podpisujacy".to_string())?;
    if crypto::node_id_from_signing_public(&signing_public) != body.node_id {
        return Err("Node ID wizytowki nie odpowiada kluczowi".to_string());
    }
    let canonical = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    if !crypto::verify(&signing_public, &canonical, &envelope.signature) {
        return Err("Podpis wizytowki jest nieprawidlowy".to_string());
    }
    let encryption_public = crypto::parse_public(&body.encryption_public_b64)
        .ok_or_else(|| "Wizytowka ma nieprawidlowy klucz szyfrujacy".to_string())?;
    if !state.remember_identity(
        &body.node_id,
        encryption_public,
        &body.signing_public_b64,
        Some(&body.name),
        body.issued_at_ms,
    ) {
        return Err("Nie mozna zapisac pinu z wizytowki".to_string());
    }
    state.trust_peer(&body.node_id)?;
    Ok(ContactCardInfo {
        node_id: body.node_id.clone(),
        name: body.name.clone(),
    })
}

fn create_envelope(
    state: &MeshState,
    msg_type: &str,
    recipient_id: &str,
    max_hops: u8,
    ciphertext: Option<String>,
    nonce: Option<String>,
    presence_name: Option<String>,
    ack_msg_id: Option<String>,
    sos: Option<SosPayload>,
) -> Result<MeshEnvelope, String> {
    let body = MeshEnvelopeBody {
        version: PROTOCOL_VERSION,
        msg_id: uuid::Uuid::new_v4().to_string(),
        msg_type: msg_type.to_string(),
        sender_id: state.node_id.clone(),
        sender_encryption_pubkey: crypto::encryption_public_b64(&state.public),
        sender_signing_pubkey: crypto::signing_public_b64(&state.signing_identity.verifying_key()),
        recipient_id: recipient_id.to_string(),
        created_at_ms: now_ms(),
        max_hops,
        ciphertext,
        nonce,
        presence_name,
        ack_msg_id,
        sos,
    };
    let canonical =
        serde_json::to_vec(&body).map_err(|e| format!("Nie mozna podpisac koperty mesh: {e}"))?;
    let signature = crypto::sign(&state.signing_identity, &canonical);
    Ok(MeshEnvelope {
        body,
        hops_remaining: max_hops,
        signature,
    })
}

fn serialize_envelope(envelope: &MeshEnvelope) -> Result<String, String> {
    let json = serde_json::to_string(envelope)
        .map_err(|e| format!("Nie mozna zserializowac koperty mesh: {e}"))?;
    if json.len() > MAX_ENVELOPE_BYTES {
        return Err(format!(
            "Koperta mesh przekracza limit {} bajtow",
            MAX_ENVELOPE_BYTES
        ));
    }
    Ok(json)
}

fn relay(
    state: &MeshState,
    envelope: &MeshEnvelope,
    exclude_address: Option<&str>,
) -> Result<usize, String> {
    let json = serialize_envelope(envelope)?;
    let addresses: Vec<String> = state
        .connected_addresses
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|address| Some(address.as_str()) != exclude_address)
        .cloned()
        .collect();

    let mut queued = 0;
    for address in addresses {
        if matches!(state.transport.send(&address, &json), Ok(true)) {
            queued += 1;
        }
    }
    Ok(queued)
}

pub fn send_presence(state: &MeshState, to_address: &str) -> Result<(), String> {
    let name = truncate_utf8(
        state
            .node_name
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .trim(),
        MAX_NAME_BYTES,
    );
    let envelope = create_envelope(
        state,
        "presence",
        "*",
        1,
        None,
        None,
        Some(name),
        None,
        None,
    )?;
    let json = serialize_envelope(&envelope)?;
    match state.transport.send(to_address, &json) {
        Ok(true) => Ok(()),
        Ok(false) => Err("Nie udalo sie zakolejkowac presence w BLE".to_string()),
        Err(error) => Err(error),
    }
}

pub fn send_text(state: &MeshState, recipient_id: &str, text: &str) -> Result<SendResult, String> {
    if !crypto::is_valid_node_id(recipient_id) {
        return Err("Nieprawidlowy Node ID odbiorcy".to_string());
    }
    if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "Wiadomosc musi miec od 1 do {} bajtow",
            MAX_TEXT_BYTES
        ));
    }
    let public = state
        .known_pubkeys
        .lock()
        .map_err(|e| e.to_string())?
        .get(recipient_id)
        .cloned()
        .ok_or_else(|| {
            "Nieznany klucz publiczny odbiorcy - wymagane jest uwierzytelnione presence".to_string()
        })?;

    let (ciphertext, nonce) = crypto::encrypt(&state.identity, &public, text)?;
    let envelope = create_envelope(
        state,
        "text",
        recipient_id,
        MAX_TTL,
        Some(ciphertext),
        Some(nonce),
        None,
        None,
        None,
    )?;
    state.mark_seen(&envelope.body.msg_id, envelope.body.created_at_ms);
    // Keep the signed ciphertext in the encrypted outbox until a signed ACK is
    // received. This permits retry after a late GATT failure or reconnect.
    state.store.enqueue_outbox(OutboxRecord {
        msg_id: envelope.body.msg_id.clone(),
        envelope_json: serialize_envelope(&envelope)?,
        created_at_ms: envelope.body.created_at_ms,
    })?;
    let sent_to_transport = relay(state, &envelope, None)? > 0;
    Ok(SendResult {
        msg_id: envelope.body.msg_id,
        queued: !sent_to_transport,
    })
}

pub fn send_location(
    state: &MeshState,
    recipient_id: &str,
    lat: f64,
    lon: f64,
) -> Result<String, String> {
    validate_coordinates(lat, lon)?;
    if !crypto::is_valid_node_id(recipient_id) {
        return Err("Nieprawidlowy Node ID odbiorcy".to_string());
    }
    let public = state
        .known_pubkeys
        .lock()
        .map_err(|e| e.to_string())?
        .get(recipient_id)
        .cloned()
        .ok_or_else(|| "Nieznany klucz publiczny odbiorcy".to_string())?;
    let payload = format!("{lat},{lon}");
    let (ciphertext, nonce) = crypto::encrypt(&state.identity, &public, &payload)?;
    let envelope = create_envelope(
        state,
        "location",
        recipient_id,
        4,
        Some(ciphertext),
        Some(nonce),
        None,
        None,
        None,
    )?;
    state.mark_seen(&envelope.body.msg_id, envelope.body.created_at_ms);
    if relay(state, &envelope, None)? == 0 {
        return Err("Brak dostepnej trasy BLE do odbiorcy".to_string());
    }
    Ok(envelope.body.msg_id)
}

pub fn send_sos(
    state: &MeshState,
    name: String,
    description: String,
    lat: Option<f64>,
    lon: Option<f64>,
) -> Result<String, String> {
    let name = name.trim();
    let description = description.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_BYTES {
        return Err(format!(
            "Nazwa SOS moze miec maksymalnie {MAX_NAME_BYTES} znakow"
        ));
    }
    if description.is_empty() || description.chars().count() > MAX_DESCRIPTION_BYTES {
        return Err(format!(
            "Opis SOS moze miec maksymalnie {MAX_DESCRIPTION_BYTES} znakow"
        ));
    }
    match (lat, lon) {
        (Some(lat), Some(lon)) => validate_coordinates(lat, lon)?,
        (None, None) => {}
        _ => return Err("Lokalizacja SOS musi zawierac lat i lon".to_string()),
    }

    let mut last_sent = state.last_sos_sent.lock().map_err(|e| e.to_string())?;
    if last_sent.is_some_and(|last| last.elapsed() < SOS_COOLDOWN) {
        return Err("SOS mozna wyslac najwyzej raz na minute".to_string());
    }

    let envelope = create_envelope(
        state,
        "sos",
        "*",
        MAX_TTL,
        None,
        None,
        None,
        None,
        Some(SosPayload {
            name: name.to_string(),
            description: description.to_string(),
            lat,
            lon,
        }),
    )?;
    state.mark_seen(&envelope.body.msg_id, envelope.body.created_at_ms);
    if relay(state, &envelope, None)? == 0 {
        return Err("Nie mozna wyslac SOS: brak polaczonych wezlow BLE".to_string());
    }
    *last_sent = Some(Instant::now());
    Ok(envelope.body.msg_id)
}

fn send_ack(state: &MeshState, recipient_id: &str, ack_for_msg_id: &str) {
    let Ok(envelope) = create_envelope(
        state,
        "ack",
        recipient_id,
        MAX_TTL,
        None,
        None,
        None,
        Some(ack_for_msg_id.to_string()),
        None,
    ) else {
        return;
    };
    state.mark_seen(&envelope.body.msg_id, envelope.body.created_at_ms);
    let _ = relay(state, &envelope, None);
}

pub fn flush_outbox(app: &AppHandle, state: &MeshState) {
    let now = now_ms();
    if let Ok(expired) = state.store.prune_outbox(now) {
        for msg_id in expired {
            let _ = app.emit(
                "message_transport_failed",
                serde_json::json!({ "msgId": msg_id, "reason": "Wiadomosc w outbox wygasla" }),
            );
        }
    }
    for item in state.store.outbox(now) {
        let envelope = match serde_json::from_str::<MeshEnvelope>(&item.envelope_json) {
            Ok(envelope) if envelope.body.msg_id == item.msg_id => envelope,
            _ => {
                let _ = state.store.remove_outbox(&item.msg_id);
                continue;
            }
        };
        if relay(state, &envelope, None).unwrap_or(0) > 0 {
            let _ = app.emit(
                "message_transport_sent",
                serde_json::json!({ "msgId": item.msg_id }),
            );
        }
    }
}

fn validate_coordinates(lat: f64, lon: f64) -> Result<(), String> {
    if !lat.is_finite()
        || !lon.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
    {
        return Err("Nieprawidlowe wspolrzedne geograficzne".to_string());
    }
    Ok(())
}

fn validate_envelope(raw_json: &str) -> Result<ValidatedEnvelope, String> {
    if raw_json.is_empty() || raw_json.len() > MAX_ENVELOPE_BYTES {
        return Err("Nieprawidlowy rozmiar koperty mesh".to_string());
    }
    let envelope: MeshEnvelope = serde_json::from_str(raw_json)
        .map_err(|_| "Nieprawidlowy JSON koperty mesh".to_string())?;
    let body = &envelope.body;

    if body.version != PROTOCOL_VERSION
        || body.msg_id.parse::<uuid::Uuid>().is_err()
        || !crypto::is_valid_node_id(&body.sender_id)
        || body.recipient_id.len() > 64
        || body.max_hops == 0
        || body.max_hops > MAX_TTL
        || envelope.hops_remaining > body.max_hops
    {
        return Err("Nieprawidlowy naglowek koperty mesh".to_string());
    }

    let now = now_ms();
    if body.created_at_ms > now.saturating_add(FUTURE_CLOCK_SKEW_MS)
        || now.saturating_sub(body.created_at_ms) > MESSAGE_MAX_AGE_MS
    {
        return Err("Koperta mesh jest przeterminowana".to_string());
    }

    let signing_public = crypto::parse_signing_public(&body.sender_signing_pubkey)
        .ok_or_else(|| "Nieprawidlowy klucz podpisujacy".to_string())?;
    if crypto::node_id_from_signing_public(&signing_public) != body.sender_id {
        return Err("Node ID nie odpowiada kluczowi podpisujacemu".to_string());
    }
    let canonical =
        serde_json::to_vec(body).map_err(|_| "Nie mozna zweryfikowac koperty mesh".to_string())?;
    if !crypto::verify(&signing_public, &canonical, &envelope.signature) {
        return Err("Nieprawidlowy podpis koperty mesh".to_string());
    }

    let encryption_public = crypto::parse_public(&body.sender_encryption_pubkey)
        .ok_or_else(|| "Nieprawidlowy klucz szyfrujacy".to_string())?;

    let encrypted_fields_valid = body
        .ciphertext
        .as_ref()
        .is_some_and(|value| !value.is_empty() && value.len() <= 3_200)
        && body
            .nonce
            .as_ref()
            .is_some_and(|value| !value.is_empty() && value.len() <= 64);

    match body.msg_type.as_str() {
        "presence" => {
            if body.recipient_id != "*"
                || body.max_hops != 1
                || body.ciphertext.is_some()
                || body.nonce.is_some()
                || body.ack_msg_id.is_some()
                || body.sos.is_some()
                || !body
                    .presence_name
                    .as_ref()
                    .is_some_and(|name| !name.trim().is_empty() && name.len() <= MAX_NAME_BYTES)
            {
                return Err("Nieprawidlowa koperta presence".to_string());
            }
        }
        "text" | "location" => {
            if !crypto::is_valid_node_id(&body.recipient_id)
                || !encrypted_fields_valid
                || body.presence_name.is_some()
                || body.ack_msg_id.is_some()
                || body.sos.is_some()
            {
                return Err("Nieprawidlowa zaszyfrowana koperta".to_string());
            }
        }
        "ack" => {
            if !crypto::is_valid_node_id(&body.recipient_id)
                || body.ciphertext.is_some()
                || body.nonce.is_some()
                || body.presence_name.is_some()
                || body.sos.is_some()
                || !body
                    .ack_msg_id
                    .as_ref()
                    .is_some_and(|id| id.parse::<uuid::Uuid>().is_ok())
            {
                return Err("Nieprawidlowa koperta ACK".to_string());
            }
        }
        "sos" => {
            let valid_sos = body.sos.as_ref().is_some_and(|sos| {
                !sos.name.trim().is_empty()
                    && sos.name.chars().count() <= MAX_NAME_BYTES
                    && !sos.description.trim().is_empty()
                    && sos.description.chars().count() <= MAX_DESCRIPTION_BYTES
                    && match (sos.lat, sos.lon) {
                        (Some(lat), Some(lon)) => validate_coordinates(lat, lon).is_ok(),
                        (None, None) => true,
                        _ => false,
                    }
            });
            if body.recipient_id != "*"
                || !valid_sos
                || body.ciphertext.is_some()
                || body.nonce.is_some()
                || body.presence_name.is_some()
                || body.ack_msg_id.is_some()
            {
                return Err("Nieprawidlowa koperta SOS".to_string());
            }
        }
        _ => return Err("Nieobslugiwany typ koperty mesh".to_string()),
    }

    Ok(ValidatedEnvelope {
        sender_signing_public_b64: envelope.body.sender_signing_pubkey.clone(),
        envelope,
        sender_encryption_public: encryption_public,
    })
}

pub fn handle_incoming(app: &AppHandle, state: &MeshState, from_address: &str, raw_json: &str) {
    let ValidatedEnvelope {
        envelope,
        sender_encryption_public,
        sender_signing_public_b64,
    } = match validate_envelope(raw_json) {
        Ok(envelope) => envelope,
        Err(_) => return,
    };
    let body = &envelope.body;

    if body.sender_id == state.node_id {
        return;
    }
    if !state.mark_seen(&body.msg_id, body.created_at_ms) {
        // ACK may have been lost. A duplicate signed text addressed to us is
        // acknowledged again without emitting a duplicate chat message.
        if body.msg_type == "text" && body.recipient_id == state.node_id {
            send_ack(state, &body.sender_id, &body.msg_id);
        }
        return;
    }
    if !state.allow_incoming(&body.sender_id, now_ms()) {
        return;
    }
    let reject_unknown_chat = state
        .settings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .reject_new_chats
        && body.msg_type == "text"
        && !state.store.is_peer_trusted(&body.sender_id);
    if reject_unknown_chat {
        return;
    }
    if !state.remember_identity(
        &body.sender_id,
        sender_encryption_public,
        &sender_signing_public_b64,
        body.presence_name.as_deref(),
        body.created_at_ms,
    ) {
        return;
    }
    match body.msg_type.as_str() {
        "presence" => {
            let sender_name = body
                .presence_name
                .clone()
                .unwrap_or_else(|| body.sender_id.clone());
            state.mark_connected(from_address);
            state.bind_address_to_peer(from_address, &body.sender_id, &sender_name);

            let app_state = app.state::<crate::AppState>();
            let mut peers = app_state.peers.lock().unwrap_or_else(|e| e.into_inner());
            let existing = peers.iter_mut().find(|peer| peer.id == body.sender_id);
            let already_known = existing.is_some();
            if let Some(peer) = existing {
                peer.name = sender_name.clone();
                peer.online = true;
                peer.last_seen = Some(chrono::Utc::now().to_rfc3339());
            } else if peers.len() < MAX_STATE_PEERS {
                peers.push(crate::Peer {
                    id: body.sender_id.clone(),
                    name: sender_name.clone(),
                    online: true,
                    last_seen: Some(chrono::Utc::now().to_rfc3339()),
                });
            } else {
                return;
            }
            drop(peers);

            let _ = app.emit(
                "peer_discovered",
                serde_json::json!({
                    "id": body.sender_id,
                    "name": sender_name,
                    "online": true
                }),
            );
            let _ = app.emit(
                "peer_status",
                serde_json::json!({ "id": body.sender_id, "online": true }),
            );
            if !already_known {
                let _ = send_presence(state, from_address);
            }
            return;
        }
        "text" if body.recipient_id == state.node_id => {
            if let (Some(ciphertext), Some(nonce)) = (&body.ciphertext, &body.nonce) {
                if let Some(text) = crypto::decrypt(
                    &state.identity,
                    &sender_encryption_public,
                    ciphertext,
                    nonce,
                ) {
                    if text.len() <= MAX_TEXT_BYTES {
                        let _ = app.emit(
                            "message_received",
                            serde_json::json!({
                                "id": body.msg_id,
                                "peerId": body.sender_id,
                                "text": text,
                                "timestamp": body.created_at_ms
                            }),
                        );
                        send_ack(state, &body.sender_id, &body.msg_id);
                    }
                }
            }
            return;
        }
        "ack" if body.recipient_id == state.node_id => {
            if let Some(ack_id) = &body.ack_msg_id {
                let _ = state.store.remove_outbox(ack_id);
                let _ = app.emit(
                    "message_ack_received",
                    serde_json::json!({
                        "msgId": ack_id,
                        "peerId": body.sender_id,
                    }),
                );
            }
            return;
        }
        "location" if body.recipient_id == state.node_id => {
            if let (Some(ciphertext), Some(nonce)) = (&body.ciphertext, &body.nonce) {
                if let Some(payload) = crypto::decrypt(
                    &state.identity,
                    &sender_encryption_public,
                    ciphertext,
                    nonce,
                ) {
                    let mut parts = payload.split(',');
                    if let (Some(lat), Some(lon), None) = (parts.next(), parts.next(), parts.next())
                    {
                        if let (Ok(lat), Ok(lon)) = (lat.parse::<f64>(), lon.parse::<f64>()) {
                            if validate_coordinates(lat, lon).is_ok() {
                                let _ = app.emit(
                                    "peer_location_received",
                                    serde_json::json!({
                                        "peerId": body.sender_id,
                                        "lat": lat,
                                        "lon": lon,
                                        "timestamp": body.created_at_ms
                                    }),
                                );
                            }
                        }
                    }
                }
            }
            return;
        }
        "sos" => {
            let mut received = state
                .last_sos_received
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let should_emit = received
                .get(&body.sender_id)
                .is_none_or(|last| last.elapsed() >= SOS_COOLDOWN);
            if should_emit {
                received.insert(body.sender_id.clone(), Instant::now());
                if let Some(sos) = &body.sos {
                    let _ = app.emit(
                        "sos_received",
                        serde_json::json!({
                            "id": body.msg_id,
                            "senderId": body.sender_id,
                            "name": sos.name,
                            "description": sos.description,
                            "lat": sos.lat,
                            "lon": sos.lon,
                            "timestamp": body.created_at_ms
                        }),
                    );
                }
            }
        }
        "text" | "ack" | "location" => {}
        _ => return,
    }

    let relay_enabled = state
        .settings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .relay_node;
    if relay_enabled && envelope.hops_remaining > 0 {
        let mut forwarded = envelope;
        forwarded.hops_remaining -= 1;
        if forwarded.hops_remaining > 0 {
            let _ = relay(state, &forwarded, Some(from_address));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MockTransport {
        sent: Mutex<Vec<(String, String)>>,
    }

    impl MeshTransport for MockTransport {
        fn send(&self, address: &str, payload: &str) -> Result<bool, String> {
            self.sent
                .lock()
                .unwrap()
                .push((address.to_string(), payload.to_string()));
            Ok(true)
        }
    }

    fn state_with_transport(seed: u8) -> (MeshState, Arc<MockTransport>) {
        let encryption = StaticSecret::from([seed; 32]);
        let public = PublicKey::from(&encryption);
        let signing = SigningKey::from_bytes(&[seed.wrapping_add(1); 32]);
        let id = crypto::node_id_from_signing_public(&signing.verifying_key());
        let path = std::env::temp_dir()
            .join(format!("void-mesh-test-{}", uuid::Uuid::new_v4()))
            .join("vault.json");
        let store = Arc::new(SecureStore::open(path, [seed; 32], now_ms()).unwrap());
        let transport = Arc::new(MockTransport::default());
        let state = MeshState::new_inner(encryption, public, signing, id, store, transport.clone());
        (state, transport)
    }

    fn state(seed: u8) -> MeshState {
        state_with_transport(seed).0
    }

    #[test]
    fn signed_envelope_rejects_tampering() {
        let state = state(3);
        let envelope = create_envelope(
            &state,
            "presence",
            "*",
            1,
            None,
            None,
            Some("Alice".to_string()),
            None,
            None,
        )
        .unwrap();
        let mut value = serde_json::to_value(envelope).unwrap();
        value["body"]["senderId"] = serde_json::json!("VX-00000000000000000000000000000000");
        assert!(validate_envelope(&value.to_string()).is_err());
    }

    #[test]
    fn rejects_oversized_text_and_bad_coordinates() {
        let state = state(4);
        assert!(send_text(&state, "bad", "hello").is_err());
        assert!(validate_coordinates(91.0, 0.0).is_err());
        assert!(validate_coordinates(0.0, f64::NAN).is_err());
    }

    #[test]
    fn production_send_path_signs_and_encrypts_for_recipient() {
        let (alice, transport) = state_with_transport(30);
        let bob = state(40);
        let bob_card = create_contact_card(&bob).unwrap();
        import_contact_card(&alice, &bob_card).unwrap();
        alice.mark_connected("bob-address");

        let result = send_text(&alice, &bob.node_id, "authenticated hello").unwrap();
        assert!(!result.queued);
        let payload = transport.sent.lock().unwrap().last().unwrap().1.clone();
        let validated = validate_envelope(&payload).unwrap();
        assert_eq!(validated.envelope.body.msg_id, result.msg_id);
        let plaintext = crypto::decrypt(
            &bob.identity,
            &validated.sender_encryption_public,
            validated.envelope.body.ciphertext.as_deref().unwrap(),
            validated.envelope.body.nonce.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(plaintext, "authenticated hello");
    }

    #[test]
    fn signed_contact_card_pins_both_public_keys() {
        let alice = state(10);
        *alice.node_name.lock().unwrap() = "Alice".to_string();
        let bob = state(20);
        let card = create_contact_card(&alice).unwrap();
        let imported = import_contact_card(&bob, &card).unwrap();
        assert_eq!(imported.node_id, alice.node_id);
        assert_eq!(imported.name, "Alice");
        assert!(bob.store.is_peer_trusted(&alice.node_id));
        assert!(bob
            .known_pubkeys
            .lock()
            .unwrap()
            .contains_key(&alice.node_id));

        let mut tampered = card.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        assert!(import_contact_card(&bob, &String::from_utf8(tampered).unwrap()).is_err());
    }
}
