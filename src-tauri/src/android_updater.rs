use tauri::AppHandle;

const REPOSITORY: &str = "mrkrecha3321-max/Void";
#[cfg(target_os = "android")]
const MAX_APK_BYTES: u64 = 150 * 1024 * 1024;

pub fn is_valid_release_tag(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    (2..=64).contains(&bytes.len())
        && bytes[0] == b'v'
        && bytes[1].is_ascii_digit()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_'))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseAssets {
    pub apk_url: String,
    pub checksum_url: String,
}

pub fn release_assets_from_json(json: &serde_json::Value) -> Result<ReleaseAssets, String> {
    let assets = json
        .get("assets")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Release nie zawiera listy plikow".to_string())?;
    let apk_url = asset_download_url(assets, "Void.apk")
        .ok_or_else(|| "Release nie zawiera Void.apk".to_string())?;
    let checksum_url = asset_download_url(assets, "Void.apk.sha256")
        .ok_or_else(|| "Release nie zawiera Void.apk.sha256".to_string())?;
    Ok(ReleaseAssets {
        apk_url,
        checksum_url,
    })
}

fn asset_download_url(assets: &[serde_json::Value], name: &str) -> Option<String> {
    assets.iter().find_map(|asset| {
        let asset_name = asset.get("name").and_then(|value| value.as_str())?;
        if asset_name != name {
            return None;
        }
        asset
            .get("browser_download_url")
            .and_then(|value| value.as_str())
            .filter(|url| url.starts_with("https://"))
            .map(str::to_string)
    })
}

#[cfg(target_os = "android")]
pub async fn download_and_install(app: &AppHandle, version: &str) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tauri::Manager;
    use tokio::io::AsyncWriteExt;

    if !is_valid_release_tag(version) {
        return Err("Nieprawidlowy tag release".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("void-android-updater")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let release_url = format!("https://api.github.com/repos/{REPOSITORY}/releases/tags/{version}");
    let release_json: serde_json::Value = client
        .get(&release_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Nie mozna odczytac wydania GitHub: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub nie zwrocil wydania {version}: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Nieprawidlowa odpowiedz GitHub: {e}"))?;
    let assets = release_assets_from_json(&release_json)?;

    let checksum_response = client
        .get(&assets.checksum_url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("Nie mozna pobrac sumy kontrolnej: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Serwer odrzucil sume kontrolna: {e}"))?;
    if checksum_response.content_length().unwrap_or(0) > 1_024 {
        return Err("Plik sumy kontrolnej jest zbyt duzy".to_string());
    }
    let checksum_text = checksum_response
        .text()
        .await
        .map_err(|e| format!("Nie mozna odczytac sumy kontrolnej: {e}"))?;
    if checksum_text.len() > 1_024 {
        return Err("Plik sumy kontrolnej jest zbyt duzy".to_string());
    }
    let expected_digest = checksum_text
        .split_whitespace()
        .next()
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| "Nieprawidlowy format sumy SHA-256".to_string())?
        .to_ascii_lowercase();

    let response = client
        .get(&assets.apk_url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("Nie mozna pobrac APK: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Serwer odrzucil pobieranie APK: {e}"))?;
    if response
        .content_length()
        .is_some_and(|length| length == 0 || length > MAX_APK_BYTES)
    {
        return Err("Nieprawidlowy rozmiar APK".to_string());
    }

    let updates_dir = app
        .path()
        .cache_dir()
        .map_err(|error| format!("Brak katalogu cache: {error}"))?
        .join("updates");
    tokio::fs::create_dir_all(&updates_dir)
        .await
        .map_err(|e| format!("Nie mozna utworzyc cache aktualizacji: {e}"))?;
    let temporary_path = updates_dir.join("update.apk.part");
    let apk_path = updates_dir.join("update.apk");
    let mut file = tokio::fs::File::create(&temporary_path)
        .await
        .map_err(|e| format!("Nie mozna utworzyc pliku APK: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut total = 0u64;

    let download_result = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Blad strumienia APK: {e}"))?;
            total = total.saturating_add(chunk.len() as u64);
            if total > MAX_APK_BYTES {
                return Err("APK przekracza dozwolony rozmiar".to_string());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Nie mozna zapisac APK: {e}"))?;
        }
        if total == 0 {
            return Err("Pobrany APK jest pusty".to_string());
        }
        file.flush()
            .await
            .map_err(|e| format!("Nie mozna zapisac APK na dysk: {e}"))?;
        file.sync_all()
            .await
            .map_err(|e| format!("Nie mozna zsynchronizowac APK: {e}"))?;
        Ok(())
    }
    .await;

    if let Err(error) = download_result {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error);
    }

    let actual_digest = format!("{:x}", hasher.finalize());
    if actual_digest != expected_digest {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err("Suma SHA-256 pobranego APK nie zgadza sie z release".to_string());
    }

    if tokio::fs::try_exists(&apk_path).await.unwrap_or(false) {
        tokio::fs::remove_file(&apk_path)
            .await
            .map_err(|e| format!("Nie mozna usunac starej aktualizacji: {e}"))?;
    }
    tokio::fs::rename(&temporary_path, &apk_path)
        .await
        .map_err(|e| format!("Nie mozna zatwierdzic APK: {e}"))?;

    crate::native_bridge::calls::install_apk(&apk_path.to_string_lossy())
}

#[cfg(not(target_os = "android"))]
pub async fn download_and_install(_app: &AppHandle, _version: &str) -> Result<(), String> {
    Err("Instalacja APK jest dostepna tylko na Androidzie".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_release_tags_without_allowing_paths() {
        assert!(is_valid_release_tag("v1.2.3"));
        assert!(is_valid_release_tag("v1.2.3-beta.1"));
        assert!(!is_valid_release_tag("../../main"));
        assert!(!is_valid_release_tag("https://example.com/a.apk"));
        assert!(!is_valid_release_tag("latest"));
    }

    #[test]
    fn parses_github_release_asset_urls() {
        let json = serde_json::json!({
            "tag_name": "v0.2.1",
            "assets": [
                {
                    "name": "Void.apk.sha256",
                    "browser_download_url": "https://github.com/mrkrecha3321-max/Void/releases/download/v0.2.1/Void.apk.sha256"
                },
                {
                    "name": "Void.apk",
                    "browser_download_url": "https://github.com/mrkrecha3321-max/Void/releases/download/v0.2.1/Void.apk"
                }
            ]
        });
        let assets = release_assets_from_json(&json).unwrap();
        assert!(assets.apk_url.ends_with("/Void.apk"));
        assert!(assets.checksum_url.ends_with("/Void.apk.sha256"));
        assert!(release_assets_from_json(&serde_json::json!({ "assets": [] })).is_err());
    }
}
