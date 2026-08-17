use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce as AesNonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{ChaCha20Poly1305, Nonce as ChaChaNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

const IDENTITY_VERSION: u8 = 2;

#[derive(serde::Serialize, serde::Deserialize, Zeroize)]
#[zeroize(drop)]
struct StoredIdentity {
    #[serde(default = "identity_version")]
    version: u8,
    #[serde(default)]
    x25519_secret_b64: String,
    #[serde(default)]
    ed25519_secret_b64: String,
    // Version 1 used this field for the X25519 secret. It is accepted only so
    // existing installations can migrate without losing their encryption key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    secret_b64: String,
}

fn identity_version() -> u8 {
    1
}

pub struct Identity {
    pub encryption_secret: StaticSecret,
    pub encryption_public: PublicKey,
    pub signing_secret: SigningKey,
    pub signing_public: VerifyingKey,
}

fn decode_32(value: &str, field: &str) -> Result<[u8; 32], String> {
    let mut raw = STANDARD
        .decode(value)
        .map_err(|_| format!("Nieprawidlowe kodowanie Base64 pola {field}"))?;
    if raw.len() != 32 {
        raw.zeroize();
        return Err(format!("Nieprawidlowa dlugosc pola {field}"));
    }
    let mut result = [0u8; 32];
    result.copy_from_slice(&raw);
    raw.zeroize();
    Ok(result)
}

pub(crate) fn identity_from_secrets(mut x25519: [u8; 32], mut ed25519: [u8; 32]) -> Identity {
    let encryption_secret = StaticSecret::from(x25519);
    let encryption_public = PublicKey::from(&encryption_secret);
    let signing_secret = SigningKey::from_bytes(&ed25519);
    let signing_public = signing_secret.verifying_key();
    x25519.zeroize();
    ed25519.zeroize();
    Identity {
        encryption_secret,
        encryption_public,
        signing_secret,
        signing_public,
    }
}

pub(crate) fn write_identity(path: &Path, identity: &Identity) -> Result<(), String> {
    let x25519_bytes = identity.encryption_secret.to_bytes();
    let ed25519_bytes = identity.signing_secret.to_bytes();
    let stored = StoredIdentity {
        version: IDENTITY_VERSION,
        x25519_secret_b64: STANDARD.encode(x25519_bytes),
        ed25519_secret_b64: STANDARD.encode(ed25519_bytes),
        secret_b64: String::new(),
    };
    let mut serialized = serde_json::to_vec(&stored)
        .map_err(|e| format!("Nie mozna zserializowac tozsamosci: {e}"))?;

    let parent = path
        .parent()
        .ok_or_else(|| "Sciezka tozsamosci nie ma katalogu nadrzednego".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Nie mozna utworzyc katalogu tozsamosci: {e}"))?;

    let tmp_path = path.with_extension("json.tmp");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let result = (|| -> Result<(), String> {
        let mut file = options
            .open(&tmp_path)
            .map_err(|e| format!("Nie mozna utworzyc pliku tozsamosci: {e}"))?;
        file.write_all(&serialized)
            .map_err(|e| format!("Nie mozna zapisac tozsamosci: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Nie mozna zsynchronizowac tozsamosci: {e}"))?;
        std::fs::rename(&tmp_path, path)
            .map_err(|e| format!("Nie mozna zatwierdzic pliku tozsamosci: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("Nie mozna ustawic uprawnien tozsamosci: {e}"))?;
        }
        Ok(())
    })();

    serialized.zeroize();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

pub fn load_or_create(path: &Path) -> Result<Identity, String> {
    match std::fs::read(path) {
        Ok(mut bytes) => {
            let parsed = serde_json::from_slice::<StoredIdentity>(&bytes)
                .map_err(|e| format!("Plik tozsamosci jest uszkodzony: {e}"));
            bytes.zeroize();
            let stored = parsed?;

            let x25519_value = if stored.x25519_secret_b64.is_empty() {
                &stored.secret_b64
            } else {
                &stored.x25519_secret_b64
            };
            let x25519 = decode_32(x25519_value, "x25519_secret_b64")?;

            if stored.version >= IDENTITY_VERSION && !stored.ed25519_secret_b64.is_empty() {
                let ed25519 = decode_32(&stored.ed25519_secret_b64, "ed25519_secret_b64")?;
                return Ok(identity_from_secrets(x25519, ed25519));
            }

            // One-time migration from the old unsigned protocol. Preserve the
            // X25519 key, add a signing identity, and atomically replace v1.
            let mut ed25519 = [0u8; 32];
            OsRng.fill_bytes(&mut ed25519);
            let identity = identity_from_secrets(x25519, ed25519);
            write_identity(path, &identity)?;
            Ok(identity)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let mut x25519 = [0u8; 32];
            let mut ed25519 = [0u8; 32];
            OsRng.fill_bytes(&mut x25519);
            OsRng.fill_bytes(&mut ed25519);
            let identity = identity_from_secrets(x25519, ed25519);
            write_identity(path, &identity)?;
            Ok(identity)
        }
        Err(error) => Err(format!("Nie mozna odczytac tozsamosci: {error}")),
    }
}

/// Best-effort deletion for the panic flow. Flash storage may retain old
/// physical blocks, so Android backup is disabled separately in the manifest.
pub fn destroy_identity(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Nie mozna odczytac pliku tozsamosci: {error}")),
    };

    let mut file = OpenOptions::new()
        .write(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("Nie mozna otworzyc tozsamosci do usuniecia: {e}"))?;
    let zeros = [0u8; 4_096];
    let mut remaining = metadata.len();
    while remaining > 0 {
        let chunk_len = remaining.min(zeros.len() as u64) as usize;
        file.write_all(&zeros[..chunk_len])
            .map_err(|e| format!("Nie mozna wyzerowac tozsamosci: {e}"))?;
        remaining -= chunk_len as u64;
    }
    file.sync_all()
        .map_err(|e| format!("Nie mozna zsynchronizowac usuwania tozsamosci: {e}"))?;
    drop(file);
    std::fs::remove_file(path).map_err(|e| format!("Nie mozna usunac tozsamosci: {e}"))?;
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

pub fn derive_storage_key(identity: &Identity) -> Result<[u8; 32], String> {
    let mut input = [0u8; 64];
    input[..32].copy_from_slice(&identity.encryption_secret.to_bytes());
    input[32..].copy_from_slice(&identity.signing_secret.to_bytes());
    let hkdf = Hkdf::<Sha256>::new(Some(b"void-local-vault-v2"), &input);
    let mut key = [0u8; 32];
    let result = hkdf
        .expand(b"authenticated-local-storage", &mut key)
        .map_err(|_| "Nie mozna wyprowadzic klucza lokalnego storage".to_string());
    input.zeroize();
    result.map(|_| key)
}

pub fn encryption_public_b64(public: &PublicKey) -> String {
    STANDARD.encode(public.as_bytes())
}

pub fn signing_public_b64(public: &VerifyingKey) -> String {
    STANDARD.encode(public.as_bytes())
}

pub fn node_id_from_signing_public(public: &VerifyingKey) -> String {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(public.as_bytes());
    // 128 bits keeps identifiers compact while making accidental and targeted
    // collisions impractical for this protocol.
    format!("VX-{}", hex_upper(&hash[..16]))
}

fn hex_upper(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

pub fn is_valid_node_id(value: &str) -> bool {
    value.len() == 35
        && value.starts_with("VX-")
        && value.as_bytes()[3..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit())
}

pub fn parse_public(b64: &str) -> Option<PublicKey> {
    let mut raw = STANDARD.decode(b64).ok()?;
    if raw.len() != 32 {
        raw.zeroize();
        return None;
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&raw);
    raw.zeroize();
    let public = PublicKey::from(bytes);
    bytes.zeroize();
    Some(public)
}

pub fn parse_signing_public(b64: &str) -> Option<VerifyingKey> {
    let mut raw = STANDARD.decode(b64).ok()?;
    if raw.len() != 32 {
        raw.zeroize();
        return None;
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&raw);
    raw.zeroize();
    let result = VerifyingKey::from_bytes(&bytes).ok();
    bytes.zeroize();
    result
}

pub fn sign(signing_key: &SigningKey, message: &[u8]) -> String {
    STANDARD.encode(signing_key.sign(message).to_bytes())
}

pub fn verify(public: &VerifyingKey, message: &[u8], signature_b64: &str) -> bool {
    let mut raw = match STANDARD.decode(signature_b64) {
        Ok(raw) if raw.len() == 64 => raw,
        _ => return false,
    };
    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&raw);
    raw.zeroize();
    let signature = Signature::from_bytes(&bytes);
    bytes.zeroize();
    public.verify(message, &signature).is_ok()
}

fn derive_cascade_keys(shared: &x25519_dalek::SharedSecret, salt: &[u8]) -> ([u8; 32], [u8; 32]) {
    let hk = Hkdf::<Sha256>::new(Some(salt), shared.as_bytes());
    let mut aes_key = [0u8; 32];
    let mut chacha_key = [0u8; 32];
    // SHA-256 HKDF can always expand these fixed-size outputs.
    hk.expand(b"void-inner-aes256-gcm-v2", &mut aes_key)
        .expect("fixed HKDF output length is valid");
    hk.expand(b"void-outer-chacha20-poly1305-v2", &mut chacha_key)
        .expect("fixed HKDF output length is valid");
    (aes_key, chacha_key)
}

pub fn encrypt(
    my_secret: &StaticSecret,
    their_public: &PublicKey,
    plaintext: &str,
) -> Result<(String, String), String> {
    let shared = my_secret.diffie_hellman(their_public);
    if !shared.was_contributory() {
        return Err("Odrzucono niebezpieczny klucz publiczny X25519".to_string());
    }

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_bytes);
    let (mut aes_key, mut chacha_key) = derive_cascade_keys(&shared, &salt);

    let result = (|| -> Result<(String, String), String> {
        let aes_cipher = Aes256Gcm::new((&aes_key).into());
        let inner_ciphertext = aes_cipher
            .encrypt(AesNonce::from_slice(&nonce_bytes), plaintext.as_bytes())
            .map_err(|_| "Szyfrowanie AES-GCM nie powiodlo sie".to_string())?;

        let chacha_cipher = ChaCha20Poly1305::new((&chacha_key).into());
        let outer_ciphertext = chacha_cipher
            .encrypt(
                ChaChaNonce::from_slice(&nonce_bytes),
                inner_ciphertext.as_ref(),
            )
            .map_err(|_| "Szyfrowanie ChaCha20-Poly1305 nie powiodlo sie".to_string())?;

        let mut combined_nonce = Vec::with_capacity(28);
        combined_nonce.extend_from_slice(&salt);
        combined_nonce.extend_from_slice(&nonce_bytes);
        Ok((
            STANDARD.encode(outer_ciphertext),
            STANDARD.encode(combined_nonce),
        ))
    })();

    aes_key.zeroize();
    chacha_key.zeroize();
    salt.zeroize();
    nonce_bytes.zeroize();
    result
}

pub fn decrypt(
    my_secret: &StaticSecret,
    their_public: &PublicKey,
    ciphertext_b64: &str,
    combined_nonce_b64: &str,
) -> Option<String> {
    let shared = my_secret.diffie_hellman(their_public);
    if !shared.was_contributory() {
        return None;
    }

    let mut combined = STANDARD.decode(combined_nonce_b64).ok()?;
    if combined.len() != 28 {
        combined.zeroize();
        return None;
    }
    let (mut aes_key, mut chacha_key) = derive_cascade_keys(&shared, &combined[..16]);

    let result = (|| -> Option<String> {
        let mut ciphertext = STANDARD.decode(ciphertext_b64).ok()?;
        let chacha_cipher = ChaCha20Poly1305::new((&chacha_key).into());
        let mut inner_ciphertext = chacha_cipher
            .decrypt(
                ChaChaNonce::from_slice(&combined[16..28]),
                ciphertext.as_ref(),
            )
            .ok()?;
        ciphertext.zeroize();

        let aes_cipher = Aes256Gcm::new((&aes_key).into());
        let mut plain_bytes = aes_cipher
            .decrypt(
                AesNonce::from_slice(&combined[16..28]),
                inner_ciphertext.as_ref(),
            )
            .ok()?;
        inner_ciphertext.zeroize();
        let plaintext = String::from_utf8(plain_bytes.clone()).ok();
        plain_bytes.zeroize();
        plaintext
    })();

    aes_key.zeroize();
    chacha_key.zeroize();
    combined.zeroize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authenticated_id_uses_128_bits() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let id = node_id_from_signing_public(&signing.verifying_key());
        assert!(is_valid_node_id(&id));
        assert_eq!(id.len(), 35);
    }

    #[test]
    fn cascade_round_trip_and_signature() {
        let alice_secret = StaticSecret::from([3u8; 32]);
        let bob_secret = StaticSecret::from([9u8; 32]);
        let alice_public = PublicKey::from(&alice_secret);
        let bob_public = PublicKey::from(&bob_secret);
        let (ciphertext, nonce) = encrypt(&alice_secret, &bob_public, "sekret").unwrap();
        assert_eq!(
            decrypt(&bob_secret, &alice_public, &ciphertext, &nonce).as_deref(),
            Some("sekret")
        );

        let signing = SigningKey::from_bytes(&[11u8; 32]);
        let signature = sign(&signing, b"message");
        assert!(verify(&signing.verifying_key(), b"message", &signature));
        assert!(!verify(&signing.verifying_key(), b"tampered", &signature));
    }
}
