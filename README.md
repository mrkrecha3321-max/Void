# VOID 🌌

> Eksperymentalny komunikator mesh dla Androida wykorzystujący Bluetooth Low Energy, Tauri, Rust, Kotlin i React.

VOID umożliwia komunikację bez Wi-Fi i sieci komórkowej. Wiadomości są szyfrowane przed przekazaniem do transportu BLE, a koperty protokołu v2 są podpisywane kluczem tożsamości.

> [!IMPORTANT]
> Projekt nie przeszedł jeszcze niezależnego audytu kryptograficznego ani pełnych testów na szerokiej macierzy urządzeń BLE. Nie należy traktować go jako jedynego kanału komunikacji ratunkowej.

## Architektura bezpieczeństwa protokołu v2

- **Tożsamość:** Ed25519 służy do podpisywania kopert.
- **Node ID:** `VX-` oraz 128 bitów skrótu SHA-256 klucza publicznego Ed25519.
- **Szyfrowanie wiadomości:** X25519 + HKDF-SHA-256 oraz kaskada AES-256-GCM/ChaCha20-Poly1305.
- **Uwierzytelnienie:** podpis obejmuje nadawcę, odbiorcę, typ, czas, ciphertext, nonce, maksymalną liczbę hopów i identyfikator wiadomości.
- **Routing:** podpisany limit maksymalny oraz osobny, malejący licznik pozostałych hopów.
- **Ochrona wejścia:** limity rozmiaru, TTL, liczby peerów, rate limiting oraz odrzucanie starych i niepodpisanych kopert.
- **Panic wipe:** usuwa trwałą tożsamość, czyści stan i zamyka proces.

Protokół v2 celowo nie przyjmuje kopert ze starego, niepodpisanego formatu.

### Czego projekt obecnie nie obiecuje

- Nie jest to kryptografia post-quantum.
- Obecny schemat nie jest pełnym Double Ratchet i nie zapewnia właściwości komunikatorów opartych o Signal Protocol.
- Kopia tożsamości jest szyfrowana hasłem (PBKDF2-HMAC-SHA-256 + ChaCha20-Poly1305), ale nie obejmuje historii czatów ani lokalnych pinów.

## Transport BLE

Każda wiadomość jest ramkowana, również gdy mieści się w jednym fragmencie. Aktualny nadawca używa framingu v2, którego payload wynika z wynegocjowanego MTU (`MTU - 3 - 7`). Odbiorca nadal akceptuje legacy v1.

Szczegóły ramek, stanów `queued/transmitting/transport_sent/delivered` oraz cyklu inbox→ACK są w [`docs/PROTOKOL_TRANSPORT.md`](docs/PROTOKOL_TRANSPORT.md).

- maksymalnie 2048 fragmentów v2 i 4080 bajtów wiadomości transportowej;
- bufory są izolowane przez `(adres urządzenia, Message ID)`;
- niedokończone bufory wygasają po 30 sekundach;
- obowiązują limity globalne i per urządzenie;
- zapisy GATT i notyfikacje korzystają z kolejki wiadomości powiązanej z mesh `msgId`;
- kolejny fragment startuje dopiero po callbacku poprzedniego;
- nieudane fragmenty są ponawiane z limitem prób, a błąd środka przerywa tylko tę wiadomość;
- skan, advertising i GATT utrzymuje foreground service typu `connectedDevice`.

## Lokalny zaszyfrowany vault

Dane aplikacji są zapisywane w uwierzytelnionym vault szyfrowanym kluczem wyprowadzonym z lokalnej tożsamości. Vault przechowuje:

- piny kluczy i zaufane kontakty;
- ustawienia core;
- historię czatów z limitem rozmiaru;
- podpisane ciphertexty oczekujące w outbox.

Replay ID są dopisywane do osobnego, szyfrowanego i okresowo kompaktowanego logu. Outbox jest ponawiany po reconnect i okresowo aż do otrzymania podpisanego ACK albo wygaśnięcia.

Podpisana wizytówka `VOID2:` zawiera Node ID oraz oba klucze publiczne. Jest używana przez QR i fizyczne tagi NFC; import zawsze weryfikuje podpis w Rust.

## SOS

SOS jest podpisanym broadcastem protokołu mesh z limitem 32 hopów. Zawiera nazwę, opis do 200 znaków i opcjonalne współrzędne. Wysyłanie ma cooldown, a odbiorca ogranicza częstotliwość alarmów od jednego nadawcy.

Treść SOS jest jawna dla węzłów przekazujących — jest podpisana, ale nie jest szyfrowana do jednego odbiorcy. Funkcja wymaga co najmniej jednego aktywnego połączenia BLE.

## Aktualizacje Android

APK z GitHub Releases musi być podpisany stałym release keystore. Workflow:

1. wymaga sekretów podpisujących;
2. sprawdza zgodność taga z wersją npm/Tauri/Cargo;
3. wykonuje build, testy i audyty;
4. publikuje `Void.apk` oraz `Void.apk.sha256`;
5. updater sprawdza status HTTP, rozmiar i SHA-256 przed przekazaniem APK instalatorowi Androida.

Konfiguracja sekretów jest opisana w [`docs/RELEASE_ANDROID.md`](docs/RELEASE_ANDROID.md). Klucza prywatnego nie wolno commitować do repozytorium.

## Budowanie lokalne

### Wymagania

- Node.js 20+
- Rust stable
- Java 17
- Android SDK oraz NDK `27.0.12077973`

```bash
npm ci
npm run build
npm run test:e2e

cd src-tauri
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

Build produkcyjny Androida wymaga zmiennych release signing opisanych w dokumentacji. Do developmentu można używać standardowego debug builda.

## Testowanie BLE

Testy kontraktowe w `tests/` nie zastępują testu sprzętowego. Przed wydaniem należy sprawdzić co najmniej:

- dwa różne modele telefonów;
- Android API 31, 33 i najnowsze wspierane API;
- wiadomości jedno- i wielofragmentowe;
- rozłączenie w środku transmisji;
- ponowne połączenie i wymianę presence;
- relay przez trzeci telefon;
- upgrade APK bez odinstalowania poprzedniej wersji.

## Licencja

Szczegóły znajdują się w pliku [`LICENSE`](LICENSE).
