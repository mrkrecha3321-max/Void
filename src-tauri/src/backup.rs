use crate::crypto::{self, Identity};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroize;

const BACKUP_VERSION: u8 = 1;
const PBKDF2_ITERATIONS: u32 = 250_000;
const MAX_BACKUP_BYTES: usize = 16 * 1024;

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupEnvelope {
    version: u8,
    kdf: String,
    iterations: u32,
    salt_b64: String,
    nonce_b64: String,
    ciphertext_b64: String,
}

#[derive(Serialize, Deserialize, Zeroize)]
#[zeroize(drop)]
struct BackupPlaintext {
    x25519_secret_b64: String,
    ed25519_secret_b64: String,
    node_id: String,
}

pub fn export_identity(identity: &Identity, password: &str) -> Result<String, String> {
    validate_password(password)?;
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let mut key = pbkdf2_sha256(password.as_bytes(), &salt, PBKDF2_ITERATIONS)?;
    let plaintext = BackupPlaintext {
        x25519_secret_b64: STANDARD.encode(identity.encryption_secret.to_bytes()),
        ed25519_secret_b64: STANDARD.encode(identity.signing_secret.to_bytes()),
        node_id: crypto::node_id_from_signing_public(&identity.signing_public),
    };
    let mut serialized = serde_json::to_vec(&plaintext).map_err(|e| e.to_string())?;
    let aad = backup_aad(BACKUP_VERSION, PBKDF2_ITERATIONS, &salt);
    let cipher = ChaCha20Poly1305::new((&key).into());
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &serialized,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "Nie mozna zaszyfrowac kopii tozsamosci".to_string());
    key.zeroize();
    serialized.zeroize();
    let ciphertext = encrypted?;

    let envelope = BackupEnvelope {
        version: BACKUP_VERSION,
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        iterations: PBKDF2_ITERATIONS,
        salt_b64: STANDARD.encode(salt),
        nonce_b64: STANDARD.encode(nonce),
        ciphertext_b64: STANDARD.encode(ciphertext),
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
}

pub fn import_identity(backup: &str, password: &str) -> Result<Identity, String> {
    validate_password(password)?;
    if backup.is_empty() || backup.len() > MAX_BACKUP_BYTES {
        return Err("Nieprawidlowy rozmiar kopii tozsamosci".to_string());
    }
    let envelope: BackupEnvelope = serde_json::from_str(backup)
        .map_err(|_| "Nieprawidlowy format kopii tozsamosci".to_string())?;
    if envelope.version != BACKUP_VERSION
        || envelope.kdf != "PBKDF2-HMAC-SHA256"
        || !(100_000..=1_000_000).contains(&envelope.iterations)
    {
        return Err("Nieobslugiwane parametry kopii tozsamosci".to_string());
    }
    let mut salt = STANDARD
        .decode(&envelope.salt_b64)
        .map_err(|_| "Nieprawidlowy salt kopii".to_string())?;
    let mut nonce = STANDARD
        .decode(&envelope.nonce_b64)
        .map_err(|_| "Nieprawidlowy nonce kopii".to_string())?;
    let mut ciphertext = STANDARD
        .decode(&envelope.ciphertext_b64)
        .map_err(|_| "Nieprawidlowy ciphertext kopii".to_string())?;
    if salt.len() != 16 || nonce.len() != 12 || ciphertext.len() > MAX_BACKUP_BYTES {
        salt.zeroize();
        nonce.zeroize();
        ciphertext.zeroize();
        return Err("Nieprawidlowe parametry binarne kopii".to_string());
    }

    let mut key = pbkdf2_sha256(password.as_bytes(), &salt, envelope.iterations)?;
    let aad = backup_aad(envelope.version, envelope.iterations, &salt);
    let cipher = ChaCha20Poly1305::new((&key).into());
    let decrypted = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "Bledne haslo lub uszkodzona kopia tozsamosci".to_string());
    key.zeroize();
    salt.zeroize();
    nonce.zeroize();
    ciphertext.zeroize();
    let mut plaintext = decrypted?;

    let parsed = serde_json::from_slice::<BackupPlaintext>(&plaintext)
        .map_err(|_| "Uszkodzona zawartosc kopii tozsamosci".to_string());
    plaintext.zeroize();
    let parsed = parsed?;
    let x25519 = decode_32(&parsed.x25519_secret_b64)?;
    let ed25519 = decode_32(&parsed.ed25519_secret_b64)?;
    let identity = crypto::identity_from_secrets(x25519, ed25519);
    if crypto::node_id_from_signing_public(&identity.signing_public) != parsed.node_id {
        return Err("Kopia ma niespojny Node ID".to_string());
    }
    Ok(identity)
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 12 || password.len() > 256 {
        return Err("Haslo kopii musi miec od 12 do 256 bajtow".to_string());
    }
    Ok(())
}

fn backup_aad(version: u8, iterations: u32, salt: &[u8]) -> String {
    format!(
        "VOID-IDENTITY-BACKUP|{version}|PBKDF2-HMAC-SHA256|{iterations}|{}",
        STANDARD.encode(salt)
    )
}

fn decode_32(value: &str) -> Result<[u8; 32], String> {
    let mut raw = STANDARD
        .decode(value)
        .map_err(|_| "Nieprawidlowy klucz w kopii".to_string())?;
    if raw.len() != 32 {
        raw.zeroize();
        return Err("Nieprawidlowa dlugosc klucza w kopii".to_string());
    }
    let mut result = [0u8; 32];
    result.copy_from_slice(&raw);
    raw.zeroize();
    Ok(result)
}

fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> Result<[u8; 32], String> {
    if iterations == 0 {
        return Err("Nieprawidlowa liczba iteracji KDF".to_string());
    }
    let mut first_input = Vec::with_capacity(salt.len() + 4);
    first_input.extend_from_slice(salt);
    first_input.extend_from_slice(&1u32.to_be_bytes());

    let mut mac = <HmacSha256 as Mac>::new_from_slice(password)
        .map_err(|_| "Nie mozna zainicjalizowac KDF".to_string())?;
    mac.update(&first_input);
    let mut previous: [u8; 32] = mac.finalize().into_bytes().into();
    let mut output = previous;
    for _ in 1..iterations {
        let mut mac = <HmacSha256 as Mac>::new_from_slice(password)
            .map_err(|_| "Nie mozna zainicjalizowac KDF".to_string())?;
        mac.update(&previous);
        previous = mac.finalize().into_bytes().into();
        for (target, value) in output.iter_mut().zip(previous) {
            *target ^= value;
        }
    }
    previous.zeroize();
    first_input.zeroize();
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use x25519_dalek::{PublicKey, StaticSecret};

    #[test]
    fn identity_backup_round_trip() {
        let encryption_secret = StaticSecret::from([3u8; 32]);
        let identity = Identity {
            encryption_public: PublicKey::from(&encryption_secret),
            encryption_secret,
            signing_secret: SigningKey::from_bytes(&[8u8; 32]),
            signing_public: SigningKey::from_bytes(&[8u8; 32]).verifying_key(),
        };
        let backup = export_identity(&identity, "correct horse battery staple").unwrap();
        let restored = import_identity(&backup, "correct horse battery staple").unwrap();
        assert_eq!(restored.encryption_secret.to_bytes(), [3u8; 32]);
        assert_eq!(restored.signing_secret.to_bytes(), [8u8; 32]);
        assert!(import_identity(&backup, "wrong password here").is_err());
    }
}
