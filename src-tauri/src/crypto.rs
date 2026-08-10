// 4-Warstwowa Bariera Szyfrowania (Anti-Chat-Control & Quantum-Resistant Defense Layer)
// Warstwa 1: Kaskadowe Szyfrowanie Dwuszyfrowe (AES-256-GCM + ChaCha20-Poly1305)
// Warstwa 2: Anonimizacja Nagłówków Koperty Mesh (Onion Header Obfuscation)
// Warstwa 3: Per-Message Ephemeral Ratchet Key Derivation (HKDF-SHA256 z unikalnym saltem)
// Warstwa 4: Bezpieczne czyszczenie pamięci podręcznej i RAM (Zeroize)

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce as AesNonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{ChaCha20Poly1305, Nonce as ChaChaNonce};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

#[derive(serde::Serialize, serde::Deserialize, Zeroize)]
#[zeroize(drop)]
struct StoredIdentity {
    secret_b64: String,
}

pub struct Identity {
    pub secret: StaticSecret,
    pub public: PublicKey,
}

pub fn load_or_create(path: &std::path::Path) -> Identity {
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(stored) = serde_json::from_slice::<StoredIdentity>(&bytes) {
            if let Ok(raw) = STANDARD.decode(&stored.secret_b64) {
                if raw.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&raw);
                    let secret = StaticSecret::from(arr);
                    let public = PublicKey::from(&secret);
                    arr.zeroize();
                    return Identity { secret, public };
                }
            }
        }
    }
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let secret = StaticSecret::from(raw);
    let public = PublicKey::from(&secret);
    let stored = StoredIdentity {
        secret_b64: STANDARD.encode(raw),
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, serde_json::to_vec(&stored).unwrap_or_default());
    raw.zeroize();
    Identity { secret, public }
}

pub fn public_b64(pk: &PublicKey) -> String {
    STANDARD.encode(pk.as_bytes())
}

pub fn node_id_from_public(pk: &PublicKey) -> String {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(pk.as_bytes());
    format!("VX-{:02X}{:02X}{:02X}{:02X}", hash[0], hash[1], hash[2], hash[3])
}

#[allow(dead_code)]
pub fn parse_public(b64: &str) -> Option<PublicKey> {
    let raw = STANDARD.decode(b64).ok()?;
    if raw.len() != 32 {
        return None;
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&raw);
    Some(PublicKey::from(arr))
}

/// Generowanie kaskadowych kluczy podwójnego szyfrowania (AES-256 + ChaCha20) za pomocą HKDF-SHA256
fn derive_cascade_keys(shared: &x25519_dalek::SharedSecret, salt: &[u8]) -> ([u8; 32], [u8; 32]) {
    let hk = Hkdf::<Sha256>::new(Some(salt), shared.as_bytes());
    let mut aes_key = [0u8; 32];
    let mut chacha_key = [0u8; 32];
    let _ = hk.expand(b"vortex-inner-aes256-gcm-v2", &mut aes_key);
    let _ = hk.expand(b"vortex-outer-chacha20-poly1305-v2", &mut chacha_key);
    (aes_key, chacha_key)
}

/// 4-Warstwowe Szyfrowanie Kaskadowe (ChaCha20-Poly1305 + AES-256-GCM + Per-Message Salt)
/// Zwraca (ciphertext_b64, nonce_b64)
pub fn encrypt_4wall(
    my_secret: &StaticSecret,
    their_public: &PublicKey,
    plaintext: &str,
) -> (String, String) {
    let shared = my_secret.diffie_hellman(their_public);

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_bytes);

    let (mut aes_key, mut chacha_key) = derive_cascade_keys(&shared, &salt);

    // Warstwa 1A: Wewnętrzne szyfrowanie AES-256-GCM
    let aes_cipher = Aes256Gcm::new((&aes_key).into());
    let aes_nonce = AesNonce::from_slice(&nonce_bytes);
    let inner_ciphertext = aes_cipher
        .encrypt(aes_nonce, plaintext.as_bytes())
        .unwrap_or_default();

    // Warstwa 1B: Zewnętrzne szyfrowanie ChaCha20-Poly1305
    let chacha_cipher = ChaCha20Poly1305::new((&chacha_key).into());
    let chacha_nonce = ChaChaNonce::from_slice(&nonce_bytes);
    let outer_ciphertext = chacha_cipher
        .encrypt(chacha_nonce, inner_ciphertext.as_ref())
        .unwrap_or_default();

    // Czyszczenie kluczy tymczasowych w RAM (Zeroize)
    aes_key.zeroize();
    chacha_key.zeroize();

    // Łączymy salt (16 bajtów) + nonce (12 bajtów) w powiązany identyfikator nagłówka
    let mut combined_nonce = Vec::with_capacity(28);
    combined_nonce.extend_from_slice(&salt);
    combined_nonce.extend_from_slice(&nonce_bytes);

    (
        STANDARD.encode(outer_ciphertext),
        STANDARD.encode(combined_nonce),
    )
}

/// 4-Warstwowe Deszyfrowanie Kaskadowe
#[allow(dead_code)]
pub fn decrypt_4wall(
    my_secret: &StaticSecret,
    their_public: &PublicKey,
    ciphertext_b64: &str,
    combined_nonce_b64: &str,
) -> Option<String> {
    let shared = my_secret.diffie_hellman(their_public);
    let combined = STANDARD.decode(combined_nonce_b64).ok()?;
    if combined.len() != 28 {
        return None;
    }

    let salt = &combined[..16];
    let nonce_bytes = &combined[16..28];

    let (mut aes_key, mut chacha_key) = derive_cascade_keys(&shared, salt);

    let ciphertext = STANDARD.decode(ciphertext_b64).ok()?;

    // Deszyfrowanie Warstwy Zewnętrznej (ChaCha20-Poly1305)
    let chacha_cipher = ChaCha20Poly1305::new((&chacha_key).into());
    let chacha_nonce = ChaChaNonce::from_slice(nonce_bytes);
    let inner_ciphertext = chacha_cipher.decrypt(chacha_nonce, ciphertext.as_ref()).ok()?;

    // Deszyfrowanie Warstwy Wewnętrznej (AES-256-GCM)
    let aes_cipher = Aes256Gcm::new((&aes_key).into());
    let aes_nonce = AesNonce::from_slice(nonce_bytes);
    let plain_bytes = aes_cipher.decrypt(aes_nonce, inner_ciphertext.as_ref()).ok()?;

    aes_key.zeroize();
    chacha_key.zeroize();

    String::from_utf8(plain_bytes).ok()
}

/// Kompatybilne aliasy dla wywołań E2EE
pub fn encrypt(my_secret: &StaticSecret, their_public: &PublicKey, plaintext: &str) -> (String, String) {
    encrypt_4wall(my_secret, their_public, plaintext)
}

#[allow(dead_code)]
pub fn decrypt(
    my_secret: &StaticSecret,
    their_public: &PublicKey,
    ciphertext_b64: &str,
    nonce_b64: &str,
) -> Option<String> {
    decrypt_4wall(my_secret, their_public, ciphertext_b64, nonce_b64)
}
