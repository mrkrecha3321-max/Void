# Plan napraw po audycie

## Etap P0 — bezpieczeństwo blokujące wydanie

- [x] podpisane koperty protokołu v2 (Ed25519)
- [x] powiązanie Node ID z kluczem podpisującym
- [x] 128-bitowy Node ID i odrzucanie legacy envelopes
- [x] walidacja typu, czasu, rozmiaru, TTL i podpisu przed zapisem klucza
- [x] podpisane ACK oraz metadane koperty
- [x] kontrola all-zero X25519 shared secret
- [x] limity pamięci i rate limiting wiadomości
- [x] kolejka operacji GATT oparta na callbackach
- [x] limit kolejki, retry i timeout buforów BLE
- [x] prawdziwy, podpisany SOS z opcjonalnym GPS i cooldownem
- [x] prawdziwe usuwanie identity + zamknięcie procesu
- [x] usunięcie fikcyjnego eksportu kluczy
- [x] atomowy zapis identity, obsługa błędów i wyłączony Android backup
- [x] bezpieczniejszy updater: status, limit, streaming i SHA-256
- [x] instalator APK wywoływany na `MainActivity`
- [x] release signing przez GitHub Secrets zamiast debug keystore
- [x] poprawione capabilities geolokalizacji
- [x] CSP i zawężony FileProvider
- [x] naprawiona podatność npm
- [x] propagowanie błędów wysyłki i timeout dostarczenia w UI

## Etap P1 — stan, prywatność i funkcje

- [x] trwałe, szyfrowane piny kluczy peerów
- [x] trwała, szyfrowana historia rozmów z limitem i retencją
- [x] trwały, szyfrowany replay cache
- [x] mapowanie adres BLE ↔ uwierzytelniony Node ID i statusy offline
- [x] ustawienia relay/battery/stealth/anti-spam/auto-delete w core
- [x] szyfrowany eksport i import tożsamości chroniony hasłem
- [x] podpisana wizytówka QR/NFC `VOID2:` z walidacją w Rust
- [x] lokalizacja udostępniana dopiero po jawnym opt-in
- [x] zarządzanie zgodą i listą odbiorców lokalizacji
- [x] zaszyfrowany outbox, retry po reconnect i retry okresowy do podpisanego ACK

## Etap P2 — testy i release quality gate

- [x] testy jednostkowe Rust dla podpisu, szyfrowania i walidacji koperty
- [x] workflow CI dla TypeScript/Rust/audytów
- [x] workflow release wymagający stałego keystore i sumy kontrolnej
- [x] testy Kotlin produkcyjnego kodeka ramek BLE i przypadków granicznych
- [x] testy produkcyjnego core Rust: podpisy, crypto, backup, storage i koperty
- [x] test integracyjny produkcyjnej ścieżki core przez wymienny adapter transportowy
- [x] instrumentation smoke tests Android na emulatorze x86_64 w CI
- [ ] test na minimum dwóch fizycznych urządzeniach BLE
- [ ] test upgrade APK N → N+1 i kontrola fingerprintu certyfikatu
- [ ] zewnętrzny audyt protokołu/kryptografii przed deklaracją produkcyjnej gotowości

## Ograniczenia środowiska tej sesji

Frontend, TypeScript, npm audit, format Rust i spójność lockfile można sprawdzić lokalnie. Pełny `cargo check` wymaga pobrania źródeł crates.io, które jest blokowane przez warstwę TLS tego środowiska. Build Android oraz test BLE wymagają Android SDK i fizycznych telefonów. Workflow CI wykona te kontrole po udostępnieniu zmian na GitHub.
