use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

const VAULT_VERSION: u8 = 2;
const MAX_VAULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CHAT_STATE_BYTES: usize = 1024 * 1024;
const MAX_PEERS: usize = 2_048;
const MAX_OUTBOX: usize = 500;
const MAX_REPLAY_IDS: usize = 10_000;
const REPLAY_COMPACT_BYTES: u64 = 2 * 1024 * 1024;
const REPLAY_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreSettings {
    pub relay_node: bool,
    pub battery_save: bool,
    pub hide_node: bool,
    pub reject_new_chats: bool,
    pub auto_destruct: bool,
    pub location_sharing: bool,
}

impl Default for CoreSettings {
    fn default() -> Self {
        Self {
            relay_node: true,
            battery_save: false,
            hide_node: false,
            reject_new_chats: false,
            auto_destruct: false,
            location_sharing: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerPinRecord {
    pub node_id: String,
    pub signing_public_b64: String,
    pub encryption_public_b64: String,
    pub name: String,
    pub trusted: bool,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRecord {
    pub msg_id: String,
    pub envelope_json: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultEnvelope {
    version: u8,
    nonce_b64: String,
    ciphertext_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct VaultData {
    pub version: u8,
    pub peer_pins: HashMap<String, PeerPinRecord>,
    pub trusted_contact_ids: HashSet<String>,
    pub contact_names: HashMap<String, String>,
    pub outbox: Vec<OutboxRecord>,
    pub chat_state: serde_json::Value,
    pub settings: CoreSettings,
}

impl Default for VaultData {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            peer_pins: HashMap::new(),
            trusted_contact_ids: HashSet::new(),
            contact_names: HashMap::new(),
            outbox: Vec::new(),
            chat_state: serde_json::json!({ "chats": [], "messages": {} }),
            settings: CoreSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayRecord {
    msg_id: String,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedReplayRecord {
    nonce_b64: String,
    ciphertext_b64: String,
}

struct StoreState {
    data: VaultData,
    replay_ids: VecDeque<ReplayRecord>,
}

pub struct SecureStore {
    vault_path: PathBuf,
    replay_path: PathBuf,
    key: Zeroizing<[u8; 32]>,
    state: Mutex<StoreState>,
    replay_io: Mutex<()>,
}

impl SecureStore {
    pub fn open(vault_path: PathBuf, key: [u8; 32], now_ms: u64) -> Result<Self, String> {
        let replay_path = vault_path.with_file_name("replay-v2.log");
        let key = Zeroizing::new(key);
        let data = load_vault(&vault_path, &key)?;
        let replay_ids = load_replay(&replay_path, &key, now_ms)?;
        let store = Self {
            vault_path,
            replay_path,
            key,
            state: Mutex::new(StoreState { data, replay_ids }),
            replay_io: Mutex::new(()),
        };
        if !store.vault_path.exists() {
            let guard = store.state.lock().map_err(|e| e.to_string())?;
            store.persist_locked(&guard.data)?;
        }
        Ok(store)
    }

    pub fn settings(&self) -> CoreSettings {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .data
            .settings
            .clone()
    }

    pub fn set_settings(&self, settings: CoreSettings) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.data.settings = settings;
        self.persist_locked(&state.data)
    }

    pub fn peer_pins(&self) -> Vec<PeerPinRecord> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .data
            .peer_pins
            .values()
            .cloned()
            .collect()
    }

    pub fn peer_pin(&self, node_id: &str) -> Option<PeerPinRecord> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .data
            .peer_pins
            .get(node_id)
            .cloned()
    }

    pub fn contacts(&self) -> HashMap<String, String> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .data
            .contact_names
            .clone()
    }

    pub fn add_contact(&self, node_id: &str, name: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if (state.data.contact_names.len() >= MAX_PEERS
            && !state.data.contact_names.contains_key(node_id))
            || (state.data.trusted_contact_ids.len() >= MAX_PEERS
                && !state.data.trusted_contact_ids.contains(node_id))
        {
            return Err("Osiagnieto limit kontaktow".to_string());
        }
        state
            .data
            .contact_names
            .insert(node_id.to_string(), name.to_string());
        state.data.trusted_contact_ids.insert(node_id.to_string());
        self.persist_locked(&state.data)
    }

    pub fn upsert_peer_pin(&self, mut pin: PeerPinRecord) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        pin.trusted |= state.data.trusted_contact_ids.contains(&pin.node_id);
        if state.data.peer_pins.len() >= MAX_PEERS
            && !state.data.peer_pins.contains_key(&pin.node_id)
        {
            return Err("Osiagnieto limit zapisanych pinow peerow".to_string());
        }
        if let Some(existing) = state.data.peer_pins.get(&pin.node_id) {
            if existing.signing_public_b64 != pin.signing_public_b64 {
                return Err("Proba zmiany przypietego klucza podpisujacego".to_string());
            }
        }
        if pin.trusted {
            state
                .data
                .contact_names
                .insert(pin.node_id.clone(), pin.name.clone());
        }
        state.data.peer_pins.insert(pin.node_id.clone(), pin);
        self.persist_locked(&state.data)
    }

    pub fn set_peer_trusted(&self, node_id: &str, trusted: bool) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if trusted {
            if state.data.trusted_contact_ids.len() >= MAX_PEERS
                && !state.data.trusted_contact_ids.contains(node_id)
            {
                return Err("Osiagnieto limit zaufanych kontaktow".to_string());
            }
            state.data.trusted_contact_ids.insert(node_id.to_string());
        } else {
            state.data.trusted_contact_ids.remove(node_id);
        }
        if let Some(pin) = state.data.peer_pins.get_mut(node_id) {
            pin.trusted = trusted;
        }
        self.persist_locked(&state.data)
    }

    pub fn is_peer_trusted(&self, node_id: &str) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.data.trusted_contact_ids.contains(node_id)
            || state
                .data
                .peer_pins
                .get(node_id)
                .is_some_and(|pin| pin.trusted)
    }

    pub fn replay_ids(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replay_ids
            .iter()
            .map(|record| record.msg_id.clone())
            .collect()
    }

    pub fn record_seen(&self, msg_id: &str, created_at_ms: u64) -> Result<(), String> {
        let _io_guard = self.replay_io.lock().map_err(|e| e.to_string())?;
        let record = ReplayRecord {
            msg_id: msg_id.to_string(),
            created_at_ms,
        };
        let sealed = seal_replay(&self.key, &record)?;
        ensure_parent(&self.replay_path)?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&self.replay_path)
            .map_err(|e| format!("Nie mozna otworzyc replay log: {e}"))?;
        let line = serde_json::to_vec(&sealed).map_err(|e| e.to_string())?;
        file.write_all(&line)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_data())
            .map_err(|e| format!("Nie mozna zapisac replay log: {e}"))?;

        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.replay_ids.push_back(record);
        while state.replay_ids.len() > MAX_REPLAY_IDS {
            state.replay_ids.pop_front();
        }
        if file.metadata().map(|meta| meta.len()).unwrap_or(0) > REPLAY_COMPACT_BYTES {
            rewrite_replay(&self.replay_path, &self.key, &state.replay_ids)?;
        }
        Ok(())
    }

    pub fn chat_state(&self) -> serde_json::Value {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .data
            .chat_state
            .clone()
    }

    pub fn save_chat_state(&self, chat_state: serde_json::Value) -> Result<(), String> {
        let serialized = serde_json::to_vec(&chat_state).map_err(|e| e.to_string())?;
        if serialized.len() > MAX_CHAT_STATE_BYTES {
            return Err("Historia czatow przekracza limit 1 MiB".to_string());
        }
        validate_chat_shape(&chat_state)?;
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.data.chat_state = chat_state;
        self.persist_locked(&state.data)
    }

    pub fn outbox(&self, now_ms: u64) -> Vec<OutboxRecord> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .data
            .outbox
            .iter()
            .filter(|item| now_ms.saturating_sub(item.created_at_ms) <= REPLAY_MAX_AGE_MS)
            .cloned()
            .collect()
    }

    pub fn enqueue_outbox(&self, item: OutboxRecord) -> Result<(), String> {
        if item.envelope_json.len() > 4_080 {
            return Err("Koperta outbox jest zbyt duza".to_string());
        }
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if state
            .data
            .outbox
            .iter()
            .any(|queued| queued.msg_id == item.msg_id)
        {
            return Ok(());
        }
        if state.data.outbox.len() >= MAX_OUTBOX {
            return Err("Outbox jest pelny".to_string());
        }
        state.data.outbox.push(item);
        self.persist_locked(&state.data)
    }

    pub fn prune_outbox(&self, now_ms: u64) -> Result<Vec<String>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let mut removed = Vec::new();
        state.data.outbox.retain(|item| {
            let keep = now_ms.saturating_sub(item.created_at_ms) <= REPLAY_MAX_AGE_MS;
            if !keep {
                removed.push(item.msg_id.clone());
            }
            keep
        });
        if !removed.is_empty() {
            self.persist_locked(&state.data)?;
        }
        Ok(removed)
    }

    pub fn remove_outbox(&self, msg_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let previous_len = state.data.outbox.len();
        state.data.outbox.retain(|item| item.msg_id != msg_id);
        if previous_len != state.data.outbox.len() {
            self.persist_locked(&state.data)?;
        }
        Ok(())
    }

    pub fn destroy(&self) -> Result<(), String> {
        let _io_guard = self.replay_io.lock().map_err(|e| e.to_string())?;
        secure_remove(&self.vault_path)?;
        secure_remove(&self.replay_path)?;
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.data = VaultData::default();
        state.replay_ids.clear();
        Ok(())
    }

    fn persist_locked(&self, data: &VaultData) -> Result<(), String> {
        validate_vault_data(data)?;
        let plaintext = serde_json::to_vec(data).map_err(|e| e.to_string())?;
        let envelope = seal_bytes(&self.key, &plaintext)?;
        let serialized = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
        if serialized.len() > MAX_VAULT_BYTES {
            return Err("Zaszyfrowany vault przekracza limit".to_string());
        }
        atomic_write(&self.vault_path, &serialized)
    }
}

fn validate_vault_data(data: &VaultData) -> Result<(), String> {
    if data.version != VAULT_VERSION {
        return Err("Nieobslugiwana wersja danych vault".to_string());
    }
    if data.peer_pins.len() > MAX_PEERS
        || data.trusted_contact_ids.len() > MAX_PEERS
        || data.contact_names.len() > MAX_PEERS
        || data.outbox.len() > MAX_OUTBOX
    {
        return Err("Vault przekracza limity rekordow".to_string());
    }
    validate_chat_shape(&data.chat_state)
}

fn validate_chat_shape(value: &serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Historia czatow musi byc obiektem".to_string())?;
    if !object.get("chats").is_some_and(|item| item.is_array())
        || !object.get("messages").is_some_and(|item| item.is_object())
    {
        return Err("Nieprawidlowy format historii czatow".to_string());
    }
    Ok(())
}

fn load_vault(path: &Path, key: &[u8; 32]) -> Result<VaultData, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(VaultData::default()),
        Err(error) => return Err(format!("Nie mozna odczytac vault: {error}")),
    };
    if bytes.len() > MAX_VAULT_BYTES {
        return Err("Vault jest zbyt duzy".to_string());
    }
    let envelope: VaultEnvelope =
        serde_json::from_slice(&bytes).map_err(|_| "Vault ma nieprawidlowy format".to_string())?;
    if envelope.version != VAULT_VERSION {
        return Err("Nieobslugiwana wersja vault".to_string());
    }
    let mut plaintext = open_bytes(key, &envelope)?;
    let data = serde_json::from_slice::<VaultData>(&plaintext)
        .map_err(|_| "Nie mozna odszyfrowac zawartosci vault".to_string());
    plaintext.zeroize();
    let data = data?;
    validate_vault_data(&data)?;
    Ok(data)
}

fn load_replay(path: &Path, key: &[u8; 32], now_ms: u64) -> Result<VecDeque<ReplayRecord>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(VecDeque::new()),
        Err(error) => return Err(format!("Nie mozna odczytac replay log: {error}")),
    };
    let mut records = VecDeque::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("Nie mozna odczytac replay log: {e}"))?;
        if line.len() > 1_024 {
            return Err("Nieprawidlowy rekord replay".to_string());
        }
        let sealed: SealedReplayRecord = serde_json::from_str(&line)
            .map_err(|_| "Nieprawidlowy format replay log".to_string())?;
        let record = open_replay(key, &sealed)?;
        if now_ms.saturating_sub(record.created_at_ms) <= REPLAY_MAX_AGE_MS {
            records.push_back(record);
            while records.len() > MAX_REPLAY_IDS {
                records.pop_front();
            }
        }
    }
    Ok(records)
}

fn rewrite_replay(
    path: &Path,
    key: &[u8; 32],
    records: &VecDeque<ReplayRecord>,
) -> Result<(), String> {
    let mut output = Vec::new();
    for record in records {
        let sealed = seal_replay(key, record)?;
        serde_json::to_writer(&mut output, &sealed).map_err(|e| e.to_string())?;
        output.push(b'\n');
    }
    atomic_write(path, &output)
}

fn seal_replay(key: &[u8; 32], record: &ReplayRecord) -> Result<SealedReplayRecord, String> {
    let plaintext = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    let envelope = seal_bytes(key, &plaintext)?;
    Ok(SealedReplayRecord {
        nonce_b64: envelope.nonce_b64,
        ciphertext_b64: envelope.ciphertext_b64,
    })
}

fn open_replay(key: &[u8; 32], sealed: &SealedReplayRecord) -> Result<ReplayRecord, String> {
    let envelope = VaultEnvelope {
        version: VAULT_VERSION,
        nonce_b64: sealed.nonce_b64.clone(),
        ciphertext_b64: sealed.ciphertext_b64.clone(),
    };
    let mut plaintext = open_bytes(key, &envelope)?;
    let record =
        serde_json::from_slice(&plaintext).map_err(|_| "Nieprawidlowy rekord replay".to_string());
    plaintext.zeroize();
    record
}

fn seal_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<VaultEnvelope, String> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| "Nie mozna zaszyfrowac danych lokalnych".to_string())?;
    Ok(VaultEnvelope {
        version: VAULT_VERSION,
        nonce_b64: STANDARD.encode(nonce),
        ciphertext_b64: STANDARD.encode(ciphertext),
    })
}

fn open_bytes(key: &[u8; 32], envelope: &VaultEnvelope) -> Result<Vec<u8>, String> {
    let nonce = STANDARD
        .decode(&envelope.nonce_b64)
        .map_err(|_| "Nieprawidlowy nonce vault".to_string())?;
    if nonce.len() != 12 {
        return Err("Nieprawidlowa dlugosc nonce vault".to_string());
    }
    let mut ciphertext = STANDARD
        .decode(&envelope.ciphertext_b64)
        .map_err(|_| "Nieprawidlowy ciphertext vault".to_string())?;
    let cipher = ChaCha20Poly1305::new(key.into());
    let result = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "Uwierzytelnienie vault nie powiodlo sie".to_string());
    ciphertext.zeroize();
    result
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Brak katalogu nadrzednego storage".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Nie mozna utworzyc storage: {e}"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    ensure_parent(path)?;
    let tmp = path.with_extension("tmp");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), String> {
        let mut file = options
            .open(&tmp)
            .map_err(|e| format!("Nie mozna utworzyc pliku storage: {e}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Nie mozna zapisac storage: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("Nie mozna zatwierdzic storage: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("Nie mozna ustawic uprawnien storage: {e}"))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

fn secure_remove(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let zeros = [0u8; 4_096];
    let mut remaining = metadata.len();
    while remaining > 0 {
        let length = remaining.min(zeros.len() as u64) as usize;
        file.write_all(&zeros[..length])
            .map_err(|e| e.to_string())?;
        remaining -= length as u64;
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_bytes_detect_tampering() {
        let key = [7u8; 32];
        let mut envelope = seal_bytes(&key, b"secret").unwrap();
        envelope.ciphertext_b64.push('A');
        assert!(open_bytes(&key, &envelope).is_err());
    }

    #[test]
    fn validates_chat_shape() {
        assert!(validate_chat_shape(&serde_json::json!({
            "chats": [],
            "messages": {}
        }))
        .is_ok());
        assert!(validate_chat_shape(&serde_json::json!([])).is_err());
    }

    #[test]
    fn encrypted_store_survives_reopen_and_rejects_wrong_key() {
        let root = std::env::temp_dir().join(format!("void-store-test-{}", uuid::Uuid::new_v4()));
        let path = root.join("vault.json");
        let store = SecureStore::open(path.clone(), [4u8; 32], 1_000).unwrap();
        store
            .add_contact("VX-11111111111111111111111111111111", "Alice")
            .unwrap();
        drop(store);

        let reopened = SecureStore::open(path.clone(), [4u8; 32], 1_000).unwrap();
        assert_eq!(
            reopened
                .contacts()
                .get("VX-11111111111111111111111111111111")
                .map(String::as_str),
            Some("Alice")
        );
        drop(reopened);
        assert!(SecureStore::open(path, [9u8; 32], 1_000).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
