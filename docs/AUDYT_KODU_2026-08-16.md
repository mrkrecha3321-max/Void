# Audyt kodu i bezpieczeństwa VOID

**Data:** 2026-08-16  
**Gałąź:** `arena/01a00b0e-void`  
**Punkt bazowy:** `81387d56fa67aa56bd0d080ce4b8700a4d35c449`  
**Zakres:** frontend React/TypeScript, core Rust/Tauri, most JNI, Android Kotlin/BLE/NFC, konfiguracja Android/Tauri, aktualizator, workflow wydawniczy i testy.

## Ocena ogólna

**Ryzyko: KRYTYCZNE. Aplikacja nie jest obecnie gotowa do użycia jako bezpieczny komunikator ani narzędzie ratunkowe.**

Najpoważniejsze problemy to:

1. protokół nie uwierzytelnia nadawcy ani klucza publicznego, więc peer znajdujący się w zasięgu może podszyć się pod inny Node ID i podmienić jego klucz;
2. SOS, awaryjne usuwanie kluczy i eksport kluczy są atrapami, mimo że UI potwierdza wykonanie operacji;
3. implementacja BLE nie kolejkuje asynchronicznych operacji GATT, więc fragmenty wiadomości mogą być masowo gubione;
4. aktualizator ma błędy instalacji i procesu podpisywania wydań;
5. testy funkcjonalne w większości sprawdzają oddzielny model JavaScript, a nie kod produkcyjny Rust/Kotlin/React.

Nie znalazłem klasycznego XSS przez `innerHTML`, jawnie wpisanych sekretów ani SQL injection. Główne ryzyka znajdują się w projekcie protokołu, zarządzaniu tożsamością, transporcie BLE, aktualizatorze i rozbieżności między UI a rzeczywistą implementacją.

---

## Wyniki automatyczne

| Kontrola | Wynik |
|---|---|
| `npm ci` | PASS |
| `npm run build` | PASS |
| `npx tsc --noEmit` | PASS |
| `npm run test:e2e` | **29/31 PASS**; 2 testy nie uruchomiły `cargo check`, ponieważ w środowisku nie było `cargo` |
| `npm audit` | **1 podatność HIGH**: `nanoid@3.3.17`, GHSA-2v37-7h3g-55p8; poprawka `3.3.18` |
| skan typowych wzorców sekretów | brak trafień |
| porównanie `Cargo.lock` z bazą RustSec | brak aktywnych advisory typu vulnerability dla zablokowanych wersji; **1 ostrzeżenie unsound** (`glib 0.18.5`) i **16 ostrzeżeń unmaintained** |
| pełna kompilacja Rust/Clippy | niewykonana — brak toolchainu Rust w środowisku |
| build i test na Androidzie | niewykonany — brak SDK/urządzenia BLE/NFC |

Ważne: pozytywne wyniki testów nie potwierdzają działania realnego BLE ani E2EE. Pliki `tests/tier*.test.mjs` korzystają przede wszystkim z `tests/helpers/mesh_contracts.mjs`, czyli z osobnej symulacji logiki.

---

# Ustalenia krytyczne

## C-01 — Brak uwierzytelnienia tożsamości i możliwość podmiany klucza

**Miejsca:**

- `src-tauri/src/mesh.rs:255-271`
- `src-tauri/src/mesh.rs:323-359`
- `src-tauri/src/crypto.rs:64-68`

Każda odebrana koperta może podać dowolne `senderId` i dowolny `senderPubkey`. Core bez podpisu i bez sprawdzenia związku między nimi wykonuje:

```rust
known_pubkeys.insert(envelope.sender_id.clone(), pk);
```

Dzieje się to jeszcze przed walidacją typu wiadomości, odbiorcy i poprawności kryptograficznej całej koperty. Klucz zapisany wcześniej dla danego ID jest bez ostrzeżenia nadpisywany.

### Skutek

Złośliwy peer BLE może:

- wysłać `presence` z Node ID ofiary i własnym kluczem;
- podmienić klucz ofiary w pamięci odbiorcy;
- przechwycić kolejne wiadomości szyfrowane do tego ID;
- wysyłać wiadomości wyświetlane jako wiadomości innej osoby;
- zatruwać mapę kluczy za pomocą zwykłych kopert `ack` lub `location`;
- zmieniać niechronione metadane koperty.

Samo X25519 zapewnia uzgodnienie sekretu, ale nie podpisuje tożsamości. W projekcie nie ma implementacji Ed25519, mimo deklaracji w README.

### Zalecenie

Przeprojektować format protokołu przed dalszym wydaniem:

1. osobny, trwały klucz podpisujący Ed25519 lub zatwierdzony schemat podpisu post-quantum;
2. Node ID wyprowadzany z pełnego klucza podpisującego;
3. podpis kanonicznej koperty obejmujący co najmniej `msgId`, typ, nadawcę, odbiorcę, TTL, ciphertext, nonce i numer wersji;
4. sprawdzanie podpisu **przed** zapisem klucza, emisją eventu lub relayem;
5. TOFU/key pinning z ostrzeżeniem o zmianie klucza, najlepiej safety number/QR;
6. zakaz cichego nadpisywania znanego klucza.

## C-02 — Przycisk SOS nie wysyła żadnego sygnału

**Miejsca:**

- `src/screens/MenuScreen.tsx:81-92`
- `src/screens/MenuScreen.tsx:452-505`
- `src-tauri/src/lib.rs:57-58`

`handleSendSos` tylko uruchamia `setTimeout`, zamyka modal i pokazuje komunikat o rozesłaniu SOS do 128 hopów. Nie wywołuje API, Rust ani BLE. Backendowy `trigger_panic_button` również zwraca tylko stały tekst i nie dotyczy SOS.

`incomingSos` w `App.tsx` nigdy nie jest ustawiane przez event sieciowy. W protokole nie istnieje typ `sos`.

### Skutek

Użytkownik w sytuacji zagrożenia otrzymuje fałszywe potwierdzenie wysłania alarmu. To jest ryzyko dla zdrowia i życia, nie tylko brak funkcji.

### Zalecenie

Do czasu pełnej implementacji usunąć/wyłączyć SOS i wszystkie komunikaty sugerujące jego działanie. Implementacja wymaga osobnego, uwierzytelnionego formatu, potwierdzeń, rate limitu, ochrony przed fałszywymi alarmami i testów na fizycznych urządzeniach.

## C-03 — „Panic wipe” nie usuwa kluczy

**Miejsca:**

- `src-tauri/src/lib.rs:57-58`
- `src/screens/MenuScreen.tsx:70-78`
- `src/App.tsx:141-144` oraz `319-323`
- `src-tauri/src/crypto.rs:30-57`

Komenda `trigger_panic_button` niczego nie usuwa. Frontend czyści tylko stan React z czatami, po czym informuje:

> „Klucze i czaty zostały usunięte.”

Plik `identity.json` z kluczem prywatnym pozostaje na dysku, a aktywny `MeshState` nadal ma sekret w pamięci.

### Skutek

Fałszywe poczucie bezpieczeństwa. Po rzekomym wyczyszczeniu aplikacja nadal ma tę samą tożsamość i klucz.

### Zalecenie

Komenda Rust powinna atomowo zatrzymać mesh, usunąć trwałą tożsamość i dane, wyzerować dostępne bufory, zamknąć aplikację albo utworzyć nową tożsamość oraz zwrócić błąd, jeśli którakolwiek wymagana operacja się nie powiedzie. UI nie może potwierdzać sukcesu przed sukcesem backendu.

## C-04 — Aktualizator jest niespójny i może nie działać na Androidzie

**Miejsca:**

- `src-tauri/src/android_updater.rs:5-23`
- `src-tauri/src/native_bridge.rs:167-190`
- `src-tauri/gen/android/app/src/main/java/com/vortex/mesh/MainActivity.kt:19,104-113`
- `src-tauri/gen/android/app/build.gradle.kts:39-46`
- `.github/workflows/release.yml`

### Problem A: zły obiekt JNI

`MainActivity` przekazuje do Rust `this.applicationContext`. `android_updater.rs` pobiera ten kontekst i wywołuje na nim metodę `installApk`, ale metoda istnieje tylko w klasie `MainActivity`. Application Context nie ma takiej metody, więc wywołanie JNI powinno zakończyć się błędem `NoSuchMethodError`/`JNI call failed`.

### Problem B: release podpisywany konfiguracją debug

Build `release` ma jawnie:

```kotlin
signingConfig = signingConfigs.getByName("debug")
```

Workflow nie dostarcza trwałego keystore. Czyste runnery CI mogą generować różne debug keystore, przez co kolejne APK nie zachowują ciągłości certyfikatu. Android wymaga tego samego klucza podpisującego dla aktualizacji. Debug signing nie powinien służyć do produkcyjnej dystrybucji.

### Problem C: brak niezależnej weryfikacji artefaktu

Custom updater pobiera całe APK do RAM, nie sprawdza statusu HTTP, typu zawartości, rozmiaru, SHA-256 ani podpisanego manifestu. Mechanizm Tauri z `latest.json` jest skonfigurowany, lecz workflow publikuje tylko `Void.apk`.

### Zalecenie

- przejść na trwały release keystore przechowywany jako sekret CI lub Play App Signing;
- dodać kontrolę spójności podpisu w CI;
- użyć jednego, wspieranego mechanizmu updatera z podpisanym manifestem;
- wywoływać instalację na prawidłowym Activity na wątku UI;
- sprawdzać status 2xx, limit rozmiaru, digest i podpis przed instalacją;
- testować upgrade `N -> N+1` na urządzeniu bez odinstalowywania poprzedniej wersji.

## C-05 — Fragmenty BLE są wysyłane bez kolejki GATT

**Miejsca:**

- `src-tauri/gen/android/app/src/main/java/com/vortex/mesh/BleManager.kt:310-361`
- `src-tauri/gen/android/app/src/main/java/com/vortex/mesh/BleManager.kt:286-308`

Wszystkie koperty mesh są dłuższe niż 16 bajtów, więc trafiają do chunkowania. Kod publikuje kolejne operacje co 35 ms, ale nie czeka na:

- `onCharacteristicWrite` po stronie klienta;
- `onNotificationSent` po stronie serwera;
- potwierdzenie wyniku `writeCharacteristic`/`notifyCharacteristicChanged`.

Android GATT dopuszcza zwykle jedną operację asynchroniczną naraz. Następne wywołanie przed callbackiem może zwrócić błąd/busy albo zostać zgubione. Callback `onCharacteristicWrite` nie jest nawet zaimplementowany.

Dodatkowo `sendMessage` zwraca `true` zanim fragmenty zostaną wysłane, a funkcje zapisu ukrywają wszystkie błędy.

### Skutek

Utrata lub uszkodzenie praktycznie każdej realnej wiadomości, szczególnie na wolniejszych telefonach i przy zatłoczonym BLE.

### Zalecenie

Zbudować per-połączeniową kolejkę operacji GATT. Następny fragment wysyłać dopiero po callbacku sukcesu poprzedniego; dodać timeout, retry, anulowanie po disconnect, kontrolę wyniku API 33+, backpressure i końcowe potwierdzenie transportowe.

---

# Ustalenia wysokie

## H-01 — Node ID ma tylko 32 bity

**Miejsce:** `src-tauri/src/crypto.rs:64-68`

Node ID wykorzystuje tylko pierwsze 4 bajty SHA-256. Kolizje losowe stają się realne w okolicy dziesiątek tysięcy użytkowników, a celowy brute force identyfikatora wymaga około `2^32` prób. Dodatkowo `find_address_by_peer_id` i frontend używają dopasowań po sufiksie.

**Naprawa:** użyć co najmniej 128 bitów skrótu, sprawdzać pełne ID i nigdy nie traktować podobnego sufiksu jako dowodu tożsamości.

## H-02 — Wysłanie wiadomości zgłasza sukces mimo braku transportu

**Miejsca:** `src-tauri/src/mesh.rs:143-156,184-235`, `src/hooks/useChats.ts:97-133`

`relay` ignoruje każdy błąd i wynik `false`. `send_text` zwraca `Ok(msg_id)` nawet gdy:

- nie ma żadnego połączonego adresu;
- każdy zapis BLE się nie powiedzie;
- wiadomość przekracza limit chunkera;
- GATT nie ma jeszcze serwisu/charakterystyki.

Frontend natychmiast pokazuje wiadomość z pojedynczym „check”, a błąd tylko loguje do konsoli.

**Naprawa:** rozdzielić stany `queued`, `transport_sent`, `delivered`, `failed`; propagować wyniki, ustawić limit payloadu przed szyfrowaniem i pokazać retry/błąd.

## H-03 — Brak ochrony przed DoS/floodingiem mesh

**Miejsca:** `src-tauri/src/mesh.rs:43-53,143-156,254-397`, `BleManager.kt:42-48,114-145`

Dowolny połączony peer może generować unikalne `msgId`. Węzeł zapisze dane i rozgłosi kopertę do wszystkich sąsiadów. Brakuje:

- rate limitu per peer/adres;
- limitu `known_pubkeys`, `peers`, `discovered_peers` i liczby aktywnych `rxBuffers`;
- limitów długości pól JSON;
- odrzucenia `ttl > MAX_TTL`;
- reputacji/banowania źródła;
- budżetu relayu.

Atak zużywa RAM, baterię i pasmo BLE. Kolizja reklamowanego `shortId` dodatkowo powoduje zamknięcie poprzedniego GATT (`BleManager.kt:247-255`), co umożliwia prosty disconnect spoofing.

## H-04 — Trwała tożsamość może po cichu zniknąć albo zostać odtworzona

**Miejsce:** `src-tauri/src/crypto.rs:30-57`

Odczyt, utworzenie katalogu, serializacja i zapis ignorują błędy. Uszkodzony/nieczytelny plik powoduje ciche wygenerowanie nowej tożsamości. Zapis nie jest atomowy. Klucz jest przechowywany jako zwykły Base64 w JSON. Manifest nie wyłącza backupu aplikacji.

**Naprawa:** zwracać `Result`, użyć Android Keystore/StrongBox do ochrony klucza lub klucza opakowującego, zapisywać atomowo z bezpiecznymi uprawnieniami i nie rotować tożsamości bez jawnej decyzji użytkownika.

## H-05 — Deklarowane bezpieczeństwo nie odpowiada implementacji

**Miejsca:** README, `src-tauri/src/crypto.rs`, etykiety UI.

- brak Ed25519 i podpisów;
- brak kryptografii post-quantum, mimo etykiet „Quantum/Antykwantowo”;
- brak ratchetu: losowy salt HKDF nie zmienia trwałego klucza X25519 ani nie daje forward secrecy;
- statyczny klucz X25519 pozwala odszyfrować nagraną historię po późniejszym przejęciu sekretu;
- brak sprawdzenia contributory behavior/all-zero shared secret dla kluczy X25519;
- brak uwierzytelnienia metadanych przez AAD lub podpis.

Takie opisy należy usunąć do czasu wdrożenia i zewnętrznego przeglądu protokołu.

## H-06 — Eksport kluczy generuje fikcyjne dane

**Miejsce:** `src/screens/MenuScreen.tsx:54-68`

„Eksport” zapisuje dwa losowe napisy `E2EE-PRIV-MOCK-*` i `E2EE-PUB-MOCK-*`. Plik nie pozwoli odzyskać tożsamości, ale UI potwierdza poprawny backup.

**Naprawa:** wyłączyć funkcję albo stworzyć szyfrowany, wersjonowany backup rzeczywistego klucza z KDF, AEAD i testem importu.

## H-07 — Uprawnienia Tauri blokują geolokalizację

**Miejsce:** `src-tauri/capabilities/default.json`

Capability nie zawiera:

- `geolocation:allow-check-permissions`;
- `geolocation:allow-request-permissions`;
- `geolocation:allow-get-current-position`.

Plugin Tauri domyślnie blokuje niebezpieczne komendy. Radar będzie wpadał w obsługę błędu mimo wpisów w AndroidManifest.

## H-08 — „NFC telefon do telefonu” nie jest zaimplementowane

**Miejsca:** `src/screens/Contacts.tsx:237-267`, `NfcManager.kt`

UI prosi o zbliżenie dwóch telefonów, ale kod jedynie czyta fizyczny tag NDEF. Nie ma HCE/card emulation, Android Beam ani aktywnego zapisu profilu na drugim telefonie. `writeProfileTag` nie jest wywoływane z UI. QR wyświetla tylko ID i aplikacja nie ma skanera QR.

## H-09 — Race po przyznaniu uprawnień może reklamować pusty identyfikator

**Miejsca:** `MainActivity.kt:72-81`, `BleManager.kt:58-66,102-111,148-165`

`ensureInit` nie ustawia `localNodeId` ani `localName`, mimo komentarza twierdzącego inaczej. Jeśli callback uprawnień wystąpi przed `ble_init`, advertising ruszy z pustym `shortTag`. Późniejsze drugie `startAdvertising` może zakończyć się `ADVERTISE_FAILED_ALREADY_STARTED`, pozostawiając starą reklamę.

## H-10 — Błędy aktualizacji są połykane przez frontend API

**Miejsca:** `src/api.ts:23-27`, `src/App.tsx:92-101`

`installUpdate` łapie wyjątek i go nie rzuca. W efekcie `handleUpdate` nie przejdzie do swojego `catch`, a `isUpdating` może pozostać `true` na zawsze. Podobny wzorzec powoduje fałszywe sukcesy w innych komendach, np. panic wipe.

## H-11 — Znana podatność zależności npm

`npm audit` wykrywa `nanoid@3.3.17` przez `vite -> postcss -> nanoid`:

- GHSA-2v37-7h3g-55p8;
- severity raportowana przez npm: high;
- poprawiona wersja: `3.3.18`.

W obecnym użyciu jest to przede wszystkim zależność build-time i exploitability jest ograniczona, ale lockfile powinien zostać zaktualizowany przez `npm audit fix` i ponownie przetestowany.

## H-12 — Lokalizacja jest automatycznie wysyłana wszystkim peerom

**Miejsce:** `src/screens/RadarScreen.tsx:59-104`

Wejście na ekran Radar prosi o precyzyjną lokalizację i co 10 sekund wysyła ją każdemu peerowi oznaczonemu jako online. Brakuje osobnej zgody na udostępnianie, wyboru odbiorców i widocznego stanu transmisji. Status `online` może być nieaktualny lub podszyty.

---

# Ustalenia średnie

## M-01 — ACK można sfałszować

**Miejsca:** `src-tauri/src/mesh.rs:237-252,350-360`

ACK nie jest szyfrowany ani podpisany. Każdy peer znający `msgId` może wygenerować potwierdzenie i spowodować pokazanie statusu „delivered”. Frontend nie sprawdza, czy `peerId` ACK odpowiada odbiorcy wiadomości.

## M-02 — Replay starych wiadomości po wyparciu z cache

**Miejsce:** `src-tauri/src/mesh.rs:12-14,70-83`

Cache pamięta tylko 500 ID i nie ma czasu ważności, podpisanego timestampu ani licznika sesji. Po wypchnięciu ID nagrana wcześniej koperta może zostać ponownie dostarczona.

## M-03 — Klucze peerów nie są trwałe

`known_pubkeys` istnieje tylko w RAM. Po restarcie aplikacja zapomina piny i wymaga ponownego presence. Komunikat błędu sugeruje natomiast, że jednorazowe spotkanie wcześniej wystarcza. Brak trwałego pinningu ułatwia ponowną podmianę klucza.

## M-04 — Peery pozostają „online” po rozłączeniu

**Miejsca:** `src-tauri/src/native_bridge.rs:94-108`, `src/hooks/useMesh.ts:92-106`

Disconnect emituje tylko adres BLE. Nie ma niezawodnego mapowania adres -> pełny Node ID i eventu `peer_status=false`. Lista peerów/Radar może stale pokazywać rozłączone urządzenie jako online.

## M-05 — Profil użytkownika nie jest propagowany do mesh

Nazwa zmieniana w `useProfile` trafia wyłącznie do `localStorage`. Backend nadal używa domyślnego `Vortex`, więc presence i nazwy widziane przez inne urządzenia nie odpowiadają profilowi.

## M-06 — Lokalizacja i wiadomości nie mają walidacji granic

`mesh_send_location` przyjmuje dowolne `f64`, w tym NaN/Infinity i współrzędne poza zakresem. Wiadomości nie mają limitu długości. Pola `senderId`, nazwa, `msgId`, ciphertext i nonce także nie mają jawnych limitów przed deserializacją/zapisem.

## M-07 — Identyfikatory czatów oparte na `Date.now()` mogą się zderzyć

**Miejsce:** `src/hooks/useChats.ts:60,82,102,146,174`

Dwie operacje w tej samej milisekundzie mogą dostać ten sam `chatId`/lokalny message ID. Dla równoczesnych wiadomości od nowych peerów grozi to zmieszaniem rozmów.

## M-08 — Timestamp Rust nie jest poprawnie interpretowany w JavaScript

Rust emituje liczbę milisekund jako string, np. `"1786900000000"`. `new Date(payload.timestamp)` interpretuje string jako tekst daty, a nie pewną liczbę epoch; często daje `Invalid Date`, po czym frontend zastępuje czas chwilą odbioru.

**Naprawa:** emitować liczbę albo ISO-8601 i parsować zgodnie z kontraktem.

## M-09 — UI nigdy nie pokazuje błędu mesh

**Miejsce:** `src/hooks/useMesh.ts:23`

Hook deklaruje tylko `const [error] = useState(...)` bez `setError`. Jednocześnie wrappery API połykają błędy `start_mesh`. Menu w praktyce nie otrzyma informacji o awarii BLE.

## M-10 — Brak CSP i zbyt szeroki FileProvider

**Miejsca:**

- `src-tauri/tauri.conf.json:21-23` (`"csp": null`);
- `src-tauri/gen/android/app/src/main/res/xml/file_paths.xml`.

Brak CSP usuwa ważną warstwę ochrony WebView. FileProvider udostępnia konfigurację obejmującą całe external storage (`external-path path="."`), choć updater potrzebuje tylko konkretnego katalogu cache. Provider nie jest eksportowany, co ogranicza ryzyko, ale zakres należy zawęzić.

## M-11 — Testy nie wykonują kodu, który opisują

Przykłady:

- test „startup race mitigation” sprawdza helper JS, podczas gdy produkcyjne `ensureInit` ma opisany race;
- test walidacji Peer ID sprawdza helper, ale produkcyjny `add_peer` przyjmuje dowolny string;
- testy E2EE nie uruchamiają `crypto.rs`;
- testy GATT/chunkingu nie uruchamiają `BleManager.kt`;
- brak testów Rust `#[cfg(test)]`, Kotlin unit/instrumentation i testu na dwóch fizycznych urządzeniach.

Nazwanie ich „real-world E2E” daje nieuzasadnione zaufanie.

## M-12 — Pipeline release nie pełni roli bramki jakości

Workflow uruchamia się tylko dla taga i:

- używa `npm install` zamiast `npm ci`;
- nie uruchamia `npm run test:e2e`, Clippy, testów Rust/Kotlin ani audytów zależności;
- nie weryfikuje zgodności taga z wersją;
- nie weryfikuje certyfikatu APK, SHA-256 ani możliwości upgrade;
- odwołuje się do GitHub Actions przez ruchome tagi (`@v4`, `@stable`, `@v2`) zamiast pinów SHA;
- publikuje APK bez SBOM/provenance i bez manifestu updatera.

---

# Ustalenia niższe i jakość kodu

1. **`src-tauri/2` jest przypadkowym logiem npm** śledzonym w Git.
2. **W repo są dwa lockfile npm/bun**, co może powodować różne drzewa zależności.
3. **Śledzone są wygenerowane bundle WebView** pod `src-tauri/gen/android/.../assets`; mogą być nieaktualne względem `src/` i niepotrzebnie powiększają diffy.
4. Wiele bloków Kotlin `catch (Throwable) {}` całkowicie ukrywa awarie GATT/NFC.
5. `startAdvertising`, `startScanning` i GATT server nie mają pełnej idempotencji/lifecycle cleanup; wielokrotne starty mogą wyciekać zasoby lub zwracać mylący sukces.
6. GATT server odpowiada `GATT_SUCCESS` także dla niepoprawnych/nieobsługiwanych zapisów i uznaje dowolny zapis CCCD za połączenie, nawet wyłączenie notyfikacji.
7. Ustawienia `relayNode`, `batterySave`, `forceEncrypted`, `hideNode`, `rejectNewChats`, `autoDestruct`, wibracje i dźwięki są przechowywane, ale nie sterują backendem.
8. README mówi o React 18, podczas gdy projekt używa React 19; mówi też o Ed25519 i zabezpieczeniach, których nie ma.
9. UI obiecuje SOS 128 hopów, podczas gdy jedyna stała routingu ma `MAX_TTL = 32`, a typ SOS nie istnieje.
10. Automatyczne tworzenie czatu dla każdego presence ignoruje ustawienie anti-spam.
11. Nie ma trwałości historii czatów; restart usuwa ją niezależnie od ustawienia auto-destrukcji.
12. `decrypt_4wall` zeruje klucze tymczasowe dopiero na ścieżce sukcesu; wcześniejsze `?` omijają jawne `zeroize()`.

---

# Priorytet napraw

## P0 — przed kolejnym publicznym APK

1. Oznaczyć build jako eksperymentalny; usunąć komunikaty „bezpieczny”, „quantum”, działający SOS, działający backup i działający panic wipe.
2. Wyłączyć SOS oraz eksport/panic do czasu prawdziwej implementacji.
3. Zaprojektować i poddać osobnemu review podpisany protokół tożsamości i kopert.
4. Wdrożyć kolejkę GATT z callbackami i testem dwóch urządzeń.
5. Naprawić podpisywanie release stałym kluczem i cały przepływ aktualizacji.
6. Dodać limity, rate limiting oraz poprawne propagowanie błędów transportu.

## P1

1. Trwały key pinning i bezpieczne przechowywanie identity.
2. Poprawne capability geolokalizacji i świadomy model udostępniania lokalizacji.
3. Wdrożyć lub usunąć NFC phone-to-phone/QR scanning.
4. Podłączyć ustawienia do core albo usunąć martwe przełączniki.
5. Naprawić statusy online, identyfikatory czatów, timestampy i obsługę failed delivery.
6. Włączyć CSP i zawęzić FileProvider.

## P2 — bramka jakości

1. Testy jednostkowe Rust dla crypto/envelope/key pinning/replay/limitów.
2. Testy Kotlin dla reassembly i kolejki GATT oraz instrumentation tests.
3. Test integracyjny dwóch procesów/core, zamiast osobnej implementacji kontraktu JS.
4. Hardware matrix na co najmniej dwóch modelach/API Android.
5. CI na każdy PR: format, TypeScript, Rust fmt/clippy/test, Kotlin lint/test, npm audit, cargo audit, secret scan.
6. Release smoke test: instalacja wersji N, zachowanie danych, upgrade do N+1, sprawdzenie certyfikatu i komunikacji.

---

## Wniosek

Repozytorium ma działający build frontendu i sensowny szkielet warstw Tauri/Rust/Kotlin, ale najważniejsze właściwości produktu są obecnie niespełnione. Szyfrowanie payloadu działa na poziomie prymitywów AEAD, jednak cały system nie zapewnia wiarygodnej tożsamości, odporności na aktywnego peera ani niezawodnego transportu. Najpierw należy naprawić protokół, BLE i fałszywe funkcje bezpieczeństwa; kosmetyka UI i nowe funkcje powinny zostać wstrzymane do zamknięcia P0.
