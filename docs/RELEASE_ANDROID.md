# Bezpieczne wydanie Android APK

Workflow release nie używa już debug keystore. Bez poniższych sekretów build produkcyjny celowo kończy się błędem.

## 1. Utwórz release keystore poza repozytorium

```bash
keytool -genkeypair \
  -keystore void-release.jks \
  -alias void-release \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

Przechowuj plik i hasła w menedżerze sekretów oraz w bezpiecznej kopii offline. Utrata klucza uniemożliwi aktualizowanie istniejących instalacji APK.

**Nigdy nie dodawaj `.jks`, haseł ani zakodowanego keystore do Git.**

## 2. Dodaj GitHub Actions Secrets

W ustawieniach repozytorium dodaj:

| Secret | Wartość |
|---|---|
| `VOID_ANDROID_KEYSTORE_BASE64` | cały plik JKS zakodowany Base64 bez modyfikacji |
| `VOID_ANDROID_KEYSTORE_PASSWORD` | hasło keystore |
| `VOID_ANDROID_KEY_ALIAS` | alias, np. `void-release` |
| `VOID_ANDROID_KEY_PASSWORD` | hasło klucza |
| `VOID_ANDROID_CERT_SHA256` | fingerprint SHA-256 certyfikatu bez dwukropków |

Kodowanie:

```bash
base64 -w 0 void-release.jks
```

Na macOS:

```bash
base64 < void-release.jks | tr -d '\n'
```

Na Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("void-release.jks"))
```

Fingerprint certyfikatu uzyskasz poleceniem:

```bash
keytool -list -v -keystore void-release.jks -alias void-release \
  | sed -n 's/.*SHA256: //p' | tr -d ':'
```

Sekrety wprowadź bezpośrednio w GitHub. Nie wysyłaj ich w issue, PR, czacie ani logach.

## 3. Jednorazowa migracja ze starych APK

Poprzedni workflow podpisywał build `release` debug keystore. APK podpisane nowym prawidłowym kluczem nie zaktualizuje instalacji podpisanej innym certyfikatem.

Dla istniejących instalacji testowych konieczne będzie jednorazowe:

1. zapisanie potrzebnych danych poza aplikacją;
2. odinstalowanie starego debug-signed APK;
3. instalacja pierwszego APK podpisanego nowym release key.

Od tej chwili wszystkie wydania muszą używać dokładnie tego samego keystore.

Wbudowany updater pobiera `Void.apk` i `Void.apk.sha256` z GitHub Releases, sprawdza SHA-256 i uruchamia systemowy `PackageInstaller`. Na Androidzie 8+ użytkownik musi raz zezwolić na instalację z tej aplikacji (`Ustawienia → Instaluj nieznane aplikacje`). Po powrocie do VOID instalacja wznawia się sama. Nie wymaga już żywej instancji `MainActivity`.

## 4. Wydanie

### Automatycznie na Windows

Uruchom z katalogu repozytorium:

```bat
Publikuj_Wersje_Void.bat 0.2.1
```

Bez argumentu skrypt zapyta o wersję. Sprawdza wymagane programy i GitHub Secrets, aktualizuje wszystkie lockfile, wykonuje lokalny build, wysyła commit i tag, a następnie czeka na wynik GitHub Actions. Skrypt nie przechowuje żadnych haseł ani tokenów.

### Ręcznie

Wersje w tych plikach muszą być identyczne:

- `package.json`;
- `src-tauri/Cargo.toml`;
- `src-tauri/tauri.conf.json`.

Tag musi odpowiadać wersji:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Workflow wykonuje testy, buduje podpisane APK oraz publikuje:

- `Void.apk`;
- `Void.apk.sha256`.

## 5. Kontrola wydania

Przed udostępnieniem:

```bash
sha256sum -c Void.apk.sha256
apksigner verify --verbose --print-certs Void.apk
```

Porównaj fingerprint certyfikatu z poprzednim prawidłowym wydaniem. Wykonaj test aktualizacji na urządzeniu:

1. zainstaluj wersję N;
2. utwórz tożsamość i uruchom mesh;
3. uruchom aktualizację do N+1 bez odinstalowywania;
4. sprawdź, że Node ID i dane przetrwały, a Android zaakceptował podpis.
