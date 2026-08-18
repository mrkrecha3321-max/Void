use crate::crypto;
use crate::native_bridge;
use crate::reliability::{
    should_attempt_outbox, MAX_TRANSPORT_ATTEMPTS_PER_MINUTE, TRANSPORT_RATE_WINDOW_MS,
};
use crate::storage::{CoreSettings, InboxRecord, OutboxRecord, PeerPinRecord, SecureStore};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Hands a signed envelope to the BLE queue. `true` means the queue accepted
    /// the transfer for `msg_id`. It is NOT proof that any fragment left the radio.
    fn send(&self, address: &str, payload: &str, msg_id: &str) -> Result<bool, String>;
}

struct NativeBleTransport;

impl MeshTransport for NativeBleTransport {
    fn send(&self, address: &str, payload: &str, msg_id: &str) -> Result<bool, String> {
        native_bridge::calls::send_message(address, payload, msg_id)
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
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxMessage {
    pub id: String,
    pub peer_id: String,
    pub text: String,
    pub timestamp: u64,
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
    transport_attempts: Mutex<VecDeque<u64>>,
    retry_scheduled: AtomicBool,
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
            transport_attempts: Mutex::new(VecDeque::new()),
            retry_scheduled: AtomicBool::new(false),
        }
    }

    fn has_seen(&self, id: &str) -> bool {
        self.seen_set
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(id)
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

#[allow(clippy::too_many_arguments)]
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
    let msg_id = &envelope.body.msg_id;
    for address in addresses {
        match state.transport.send(&address, &json, msg_id) {
            Ok(true) => queued += 1,
            Ok(false) => {
                eprintln!("void-mesh: transport queue rejected msg_id={msg_id}");
            }
            Err(error) => {
                eprintln!("void-mesh: transport error msg_id={msg_id}: {error}");
            }
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
    match state
        .transport
        .send(to_address, &json, &envelope.body.msg_id)
    {
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
    // received. Queue acceptance is not delivery and is not even a radio send.
    state.store.enqueue_outbox(OutboxRecord {
        msg_id: envelope.body.msg_id.clone(),
        envelope_json: serialize_envelope(&envelope)?,
        created_at_ms: envelope.body.created_at_ms,
        last_attempt_at_ms: 0,
        attempt_count: 0,
        in_flight: false,
        last_error: None,
    })?;
    let accepted = dispatch_outbox_item(state, &envelope.body.msg_id, false)? > 0;
    Ok(SendResult {
        msg_id: envelope.body.msg_id,
        queued: !accepted,
        status: if accepted {
            "transmitting".to_string()
        } else {
            "queued".to_string()
        },
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
    flush_outbox_inner(state, false);
    emit_expired_outbox(app, state);
}

pub fn retry_outbox_item(state: &MeshState, msg_id: &str) -> Result<String, String> {
    if state.store.outbox_item(msg_id).is_none() {
        return Err("Wiadomosc nie jest w outbox".to_string());
    }
    if dispatch_outbox_item(state, msg_id, true)? > 0 {
        Ok("transmitting".to_string())
    } else {
        Ok("queued".to_string())
    }
}

fn emit_expired_outbox(app: &AppHandle, state: &MeshState) {
    let now = now_ms();
    if let Ok(expired) = state.store.prune_outbox(now) {
        for msg_id in expired {
            let _ = app.emit(
                "message_transport_failed",
                serde_json::json!({ "msgId": msg_id, "reason": "Wiadomosc w outbox wygasla" }),
            );
        }
    }
}

fn flush_outbox_inner(state: &MeshState, ignore_backoff: bool) {
    let now = now_ms();
    let _ = state.store.prune_outbox(now);
    for item in state.store.outbox(now) {
        if !should_attempt_outbox(
            item.in_flight,
            item.attempt_count,
            item.last_attempt_at_ms,
            now,
            ignore_backoff,
        ) {
            continue;
        }
        let _ = dispatch_outbox_item(state, &item.msg_id, ignore_backoff);
    }
}

fn allow_transport_attempt(state: &MeshState, now_ms: u64) -> bool {
    let mut attempts = state
        .transport_attempts
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    while attempts
        .front()
        .is_some_and(|timestamp| now_ms.saturating_sub(*timestamp) > TRANSPORT_RATE_WINDOW_MS)
    {
        attempts.pop_front();
    }
    if attempts.len() >= MAX_TRANSPORT_ATTEMPTS_PER_MINUTE {
        return false;
    }
    attempts.push_back(now_ms);
    true
}

fn dispatch_outbox_item(
    state: &MeshState,
    msg_id: &str,
    ignore_backoff: bool,
) -> Result<usize, String> {
    let Some(item) = state.store.outbox_item(msg_id) else {
        return Ok(0);
    };
    let now = now_ms();
    if !should_attempt_outbox(
        item.in_flight,
        item.attempt_count,
        item.last_attempt_at_ms,
        now,
        ignore_backoff,
    ) {
        return Ok(0);
    }
    if !allow_transport_attempt(state, now) {
        eprintln!("void-mesh: transport rate-limited msg_id={msg_id}");
        return Ok(0);
    }
    let envelope = match serde_json::from_str::<MeshEnvelope>(&item.envelope_json) {
        Ok(envelope) if envelope.body.msg_id == item.msg_id => envelope,
        _ => {
            let _ = state.store.remove_outbox(&item.msg_id);
            return Err("Uszkodzony rekord outbox".to_string());
        }
    };
    state
        .store
        .mark_outbox_attempt(msg_id, now, true)
        .map_err(|error| {
            eprintln!("void-mesh: cannot mark outbox in-flight msg_id={msg_id}: {error}");
            error
        })?;
    match relay(state, &envelope, None) {
        Ok(0) => {
            let _ = state.store.mark_outbox_in_flight(
                msg_id,
                false,
                Some("Brak gotowego lacza BLE".to_string()),
            );
            Ok(0)
        }
        Ok(accepted) => Ok(accepted),
        Err(error) => {
            let _ = state
                .store
                .mark_outbox_in_flight(msg_id, false, Some(error.clone()));
            Err(error)
        }
    }
}

pub fn on_transport_sent(app: &AppHandle, state: &MeshState, msg_id: &str) {
    if msg_id.is_empty() || msg_id.len() > 64 {
        return;
    }
    eprintln!("void-mesh: transport_sent msg_id={msg_id}");
    let _ = state.store.mark_outbox_in_flight(msg_id, false, None);
    let _ = app.emit(
        "message_transport_sent",
        serde_json::json!({ "msgId": msg_id }),
    );
}

pub fn on_transport_failed(app: &AppHandle, state: &MeshState, msg_id: &str, reason: &str) {
    if msg_id.is_empty() || msg_id.len() > 64 {
        return;
    }
    let reason = truncate_utf8(reason, 200);
    eprintln!("void-mesh: transport_failed msg_id={msg_id} reason={reason}");
    let updated = state
        .store
        .mark_outbox_in_flight(msg_id, false, Some(reason.clone()))
        .ok()
        .flatten();
    let attempts = updated.as_ref().map(|item| item.attempt_count).unwrap_or(0);
    if updated
        .as_ref()
        .is_some_and(|item| item.attempt_count >= crate::reliability::MAX_OUTBOX_ATTEMPTS)
    {
        let _ = app.emit(
            "message_transport_failed",
            serde_json::json!({ "msgId": msg_id, "reason": reason }),
        );
        return;
    }
    if !state.get_connected_addresses().is_empty() {
        schedule_outbox_retry(app, crate::reliability::outbox_backoff_ms(attempts));
    }
}

fn schedule_outbox_retry(app: &AppHandle, delay_ms: u64) {
    if state_retry_swap(app) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms.max(50))).await;
            let mesh = app.state::<MeshState>();
            mesh.retry_scheduled.store(false, Ordering::SeqCst);
            flush_outbox(&app, &mesh);
        });
    }
}

fn state_retry_swap(app: &AppHandle) -> bool {
    app.state::<MeshState>()
        .retry_scheduled
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

pub fn list_pending_inbox(state: &MeshState) -> Vec<InboxMessage> {
    state
        .store
        .inbox()
        .into_iter()
        .map(|item| InboxMessage {
            id: item.msg_id,
            peer_id: item.peer_id,
            text: item.text,
            timestamp: item.timestamp_ms,
        })
        .collect()
}

pub fn confirm_inbox(state: &MeshState, ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.len() > 1_000 {
        return Err("Zbyt wiele identyfikatorow inbox".to_string());
    }
    for id in &ids {
        if id.len() > 64 {
            return Err("Nieprawidlowy identyfikator inbox".to_string());
        }
    }
    state.store.confirm_inbox(&ids)
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
    handle_incoming_inner(state, from_address, raw_json, &mut |name, payload| {
        if name == "peer_discovered" {
            if let (Some(id), Some(peer_name), Some(online)) = (
                payload.get("id").and_then(|value| value.as_str()),
                payload.get("name").and_then(|value| value.as_str()),
                payload.get("online").and_then(|value| value.as_bool()),
            ) {
                let app_state = app.state::<crate::AppState>();
                if let Ok(mut peers) = app_state.peers.lock() {
                    if let Some(peer) = peers.iter_mut().find(|peer| peer.id == id) {
                        peer.name = peer_name.to_string();
                        peer.online = online;
                        peer.last_seen = Some(chrono::Utc::now().to_rfc3339());
                    } else if peers.len() < MAX_STATE_PEERS {
                        peers.push(crate::Peer {
                            id: id.to_string(),
                            name: peer_name.to_string(),
                            online,
                            last_seen: Some(chrono::Utc::now().to_rfc3339()),
                        });
                    }
                }
            }
        }
        let _ = app.emit(name, payload);
    });
}

fn handle_incoming_inner(
    state: &MeshState,
    from_address: &str,
    raw_json: &str,
    emit: &mut dyn FnMut(&str, serde_json::Value),
) {
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
    let addressed_text = body.msg_type == "text" && body.recipient_id == state.node_id;
    if state.has_seen(&body.msg_id) {
        // ACK may have been lost. Re-ACK only when the message is already in
        // the durable inbox or encrypted chat history. A seen-but-not-stored
        // text means persist failed, so we must not acknowledge it.
        if addressed_text && state.store.already_accepted(&body.msg_id) {
            send_ack(state, &body.sender_id, &body.msg_id);
        }
        return;
    }
    if !state.allow_incoming(&body.sender_id, now_ms()) {
        state.mark_seen(&body.msg_id, body.created_at_ms);
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
        state.mark_seen(&body.msg_id, body.created_at_ms);
        return;
    }
    let already_known_peer = state
        .known_pubkeys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&body.sender_id);
    if !state.remember_identity(
        &body.sender_id,
        sender_encryption_public,
        &sender_signing_public_b64,
        body.presence_name.as_deref(),
        body.created_at_ms,
    ) {
        return;
    }
    if !addressed_text {
        state.mark_seen(&body.msg_id, body.created_at_ms);
    }
    match body.msg_type.as_str() {
        "presence" => {
            let sender_name = body
                .presence_name
                .clone()
                .unwrap_or_else(|| body.sender_id.clone());
            state.mark_connected(from_address);
            state.bind_address_to_peer(from_address, &body.sender_id, &sender_name);
            let already_known = already_known_peer;
            emit(
                "peer_discovered",
                serde_json::json!({
                    "id": body.sender_id,
                    "name": sender_name,
                    "online": true,
                    "linkStatus": "ready"
                }),
            );
            emit(
                "peer_status",
                serde_json::json!({
                    "id": body.sender_id,
                    "online": true,
                    "linkStatus": "ready"
                }),
            );
            emit(
                "peer_link",
                serde_json::json!({
                    "id": body.sender_id,
                    "address": from_address,
                    "status": "ready"
                }),
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
                        let stored = match state.store.enqueue_inbox(InboxRecord {
                            msg_id: body.msg_id.clone(),
                            peer_id: body.sender_id.clone(),
                            text: text.clone(),
                            timestamp_ms: body.created_at_ms,
                            stored_at_ms: now_ms(),
                        }) {
                            Ok(stored) => stored,
                            Err(error) => {
                                eprintln!(
                                    "void-mesh: inbox persist failed msg_id={} err={error}",
                                    body.msg_id
                                );
                                return;
                            }
                        };
                        state.mark_seen(&body.msg_id, body.created_at_ms);
                        if stored {
                            emit(
                                "message_received",
                                serde_json::json!({
                                    "id": body.msg_id,
                                    "peerId": body.sender_id,
                                    "text": text,
                                    "timestamp": body.created_at_ms
                                }),
                            );
                        }
                        send_ack(state, &body.sender_id, &body.msg_id);
                    } else {
                        state.mark_seen(&body.msg_id, body.created_at_ms);
                    }
                } else {
                    state.mark_seen(&body.msg_id, body.created_at_ms);
                }
            } else {
                state.mark_seen(&body.msg_id, body.created_at_ms);
            }
            return;
        }
        "ack" if body.recipient_id == state.node_id => {
            if let Some(ack_id) = &body.ack_msg_id {
                let _ = state.store.remove_outbox(ack_id);
                emit(
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
                                emit(
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
                    emit(
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
        sent: Mutex<Vec<(String, String, String)>>,
        accept: Mutex<bool>,
    }

    impl MeshTransport for MockTransport {
        fn send(&self, address: &str, payload: &str, msg_id: &str) -> Result<bool, String> {
            if !*self.accept.lock().unwrap() {
                return Ok(false);
            }
            self.sent.lock().unwrap().push((
                address.to_string(),
                payload.to_string(),
                msg_id.to_string(),
            ));
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
        let transport = Arc::new(MockTransport {
            sent: Mutex::new(Vec::new()),
            accept: Mutex::new(true),
        });
        let state = MeshState::new_inner(encryption, public, signing, id, store, transport.clone());
        (state, transport)
    }

    fn state(seed: u8) -> MeshState {
        state_with_transport(seed).0
    }

    fn deliver(state: &MeshState, from: &str, raw: &str) -> Vec<(String, serde_json::Value)> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_ref = events.clone();
        handle_incoming_inner(state, from, raw, &mut |name, payload| {
            events_ref
                .lock()
                .unwrap()
                .push((name.to_string(), payload));
        });
        events.lock().unwrap().clone()
    }

    fn pair_alice_bob() -> (MeshState, Arc<MockTransport>, MeshState, Arc<MockTransport>) {
        let (alice, alice_tx) = state_with_transport(30);
        let (bob, bob_tx) = state_with_transport(40);
        let bob_card = create_contact_card(&bob).unwrap();
        import_contact_card(&alice, &bob_card).unwrap();
        let alice_card = create_contact_card(&alice).unwrap();
        import_contact_card(&bob, &alice_card).unwrap();
        alice.mark_connected("bob-address");
        bob.mark_connected("alice-address");
        (alice, alice_tx, bob, bob_tx)
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
        assert_eq!(result.status, "transmitting");
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

    #[test]
    fn inbox_persists_without_listener_and_acks_only_after_store() {
        let (alice, alice_tx, bob, bob_tx) = pair_alice_bob();
        let result = send_text(&alice, &bob.node_id, "offline delivery").unwrap();
        let payload = alice_tx.sent.lock().unwrap().last().unwrap().1.clone();

        let events = deliver(&bob, "alice-address", &payload);
        assert!(events.iter().any(|(name, _)| name == "message_received"));
        assert!(bob.store.inbox_has(&result.msg_id));
        assert!(bob_tx
            .sent
            .lock()
            .unwrap()
            .iter()
            .any(|(_, json, _)| json.contains("\"msgType\":\"ack\"")));
        assert_eq!(list_pending_inbox(&bob).len(), 1);
    }

    #[test]
    fn restart_keeps_inbox_until_history_confirm() {
        let (alice, alice_tx, bob, _) = pair_alice_bob();
        let result = send_text(&alice, &bob.node_id, "survives restart").unwrap();
        let payload = alice_tx.sent.lock().unwrap().last().unwrap().1.clone();
        deliver(&bob, "alice-address", &payload);
        assert_eq!(bob.store.inbox()[0].text, "survives restart");
        assert!(bob.store.already_accepted(&result.msg_id));
        assert!(bob
            .store
            .confirm_inbox(&[result.msg_id.clone()])
            .unwrap()
            .is_empty());
        bob.store
            .save_chat_state(serde_json::json!({
                "chats": [{ "id": "c1", "peerId": alice.node_id }],
                "messages": { "c1": [{ "id": result.msg_id, "text": "survives restart" }] }
            }))
            .unwrap();
        assert_eq!(
            bob.store.confirm_inbox(&[result.msg_id.clone()]).unwrap(),
            vec![result.msg_id.clone()]
        );
        assert!(bob.store.inbox().is_empty());
        assert!(bob.store.already_accepted(&result.msg_id));
    }

    #[test]
    fn persist_failure_does_not_ack() {
        let (alice, alice_tx, bob, bob_tx) = pair_alice_bob();
        send_text(&alice, &bob.node_id, "must not ack").unwrap();
        let payload = alice_tx.sent.lock().unwrap().last().unwrap().1.clone();
        bob.store.fail_next_persist();
        let events = deliver(&bob, "alice-address", &payload);
        assert!(!events.iter().any(|(name, _)| name == "message_received"));
        assert!(bob.store.inbox().is_empty());
        assert!(bob_tx
            .sent
            .lock()
            .unwrap()
            .iter()
            .all(|(_, json, _)| !json.contains("\"msgType\":\"ack\"")));
    }

    #[test]
    fn duplicate_after_lost_ack_reacks_once_stored() {
        let (alice, alice_tx, bob, bob_tx) = pair_alice_bob();
        let result = send_text(&alice, &bob.node_id, "dup").unwrap();
        let payload = alice_tx.sent.lock().unwrap().last().unwrap().1.clone();
        deliver(&bob, "alice-address", &payload);
        bob_tx.sent.lock().unwrap().clear();
        let events = deliver(&bob, "alice-address", &payload);
        assert!(!events.iter().any(|(name, _)| name == "message_received"));
        assert_eq!(
            bob.store
                .inbox()
                .iter()
                .filter(|item| item.msg_id == result.msg_id)
                .count(),
            1
        );
        assert!(bob_tx
            .sent
            .lock()
            .unwrap()
            .iter()
            .any(|(_, json, _)| json.contains("\"msgType\":\"ack\"")));
    }

    #[test]
    fn outbox_does_not_double_queue_while_in_flight() {
        let (alice, alice_tx, bob, _) = pair_alice_bob();
        let result = send_text(&alice, &bob.node_id, "once").unwrap();
        assert_eq!(alice_tx.sent.lock().unwrap().len(), 1);
        assert!(alice.store.outbox_item(&result.msg_id).unwrap().in_flight);
        flush_outbox_inner(&alice, true);
        assert_eq!(alice_tx.sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn flush_does_not_emit_transport_sent_on_queue_accept() {
        let (alice, _, bob, _) = pair_alice_bob();
        let result = send_text(&alice, &bob.node_id, "queued is not sent").unwrap();
        assert_eq!(result.status, "transmitting");
        assert!(alice.store.outbox_item(&result.msg_id).is_some());
    }

    #[test]
    fn reconnect_resumes_outbox_after_in_flight_reset() {
        let (alice, alice_tx, bob, _) = pair_alice_bob();
        let result = send_text(&alice, &bob.node_id, "retry later").unwrap();
        alice_tx.sent.lock().unwrap().clear();
        alice.store.reset_outbox_in_flight().unwrap();
        flush_outbox_inner(&alice, true);
        assert!(alice_tx
            .sent
            .lock()
            .unwrap()
            .iter()
            .any(|(_, _, id)| id == &result.msg_id));
    }

    #[test]
    fn many_messages_keep_distinct_mesh_ids() {
        let (alice, alice_tx, bob, _) = pair_alice_bob();
        let mut ids = Vec::new();
        for index in 0..5 {
            ids.push(send_text(&alice, &bob.node_id, &format!("burst {index}")).unwrap().msg_id);
        }
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 5);
        assert_eq!(alice_tx.sent.lock().unwrap().len(), 5);
    }

    #[test]
    fn peer_id_maps_to_single_ble_address() {
        let state = state(7);
        state.record_discovered_peer("AA:BB:CC:DD:EE:01", "ABCDEF01", "near", -40);
        state.bind_address_to_peer("AA:BB:CC:DD:EE:01", &state.node_id, "me");
        assert_eq!(
            state.peer_id_for_address("AA:BB:CC:DD:EE:01").as_deref(),
            Some(state.node_id.as_str())
        );
        assert_eq!(
            state.find_address_by_peer_id(&state.node_id).as_deref(),
            Some("AA:BB:CC:DD:EE:01")
        );
    }
}
