# VOID 🌌

> **Zdecentralizowana, szyfrowana sieć komunikacyjna Mesh oparta na technologii Bluetooth Low Energy (BLE). Komunikacja bez dostępu do Internetu, Wi-Fi oraz sieci komórkowych.**

---

## ⚡ O Projekcie

**VOID** to zoptymalizowana aplikacja mobilna stworzona w oparciu o **Tauri v2**, **Rust** oraz **Kotlin (Android Native BLE)**, umożliwiająca bezpieczną komunikację P2P (Peer-to-Peer) w warunkach braku infrastruktury sieciowej (off-grid).

Aplikacja automatycznie wykrywa węzły w zasięgu fali radiowej Bluetooth, buduje dynamiczną siatkę Mesh i przekazuje wiadomości pomiędzy urządzeniami z pełnym szyfrowaniem End-to-End (E2EE).

---

## 🌟 Główne Cechy Architektoniczne

* 🔒 **Szyfrowanie End-to-End (E2EE):** Każda wiadomość jest szyfrowana kluczami kryptograficznymi Ed25519 / X25519 przed wysłaniem w eter.
* 🆔 **Deterministyczne ID Węzła:** Identyfikator węzła (`Node ID`) jest obliczany deterministycznie z klucza publicznego (SHA-256), co gwarantuje stałą tożsamość urządzenia bez zmiennych identyfikatorów sesji.
* 📡 **Protokół chunkowania BLE:** Wiadomości są dzielone na fragmenty z 5-bajtowym nagłówkiem (1B marker + 2B Message ID + 1B Total Chunks + 1B Chunk Index) i maksymalnie 16 bajtami payloadu. Bufory odbiorcze są rozdzielane po adresie urządzenia i ID wiadomości oraz wygaszane po 30 sekundach.
* 📲 **Wsparcie dla Android 13+ (API 33+):** Pełna zgodność z nowoczesnym API Android GATT (`writeCharacteristic` & `writeDescriptor`).
* 🚨 **System Radarowy SOS:** Sygnał alarmowy propagowany przeskokowo w całej sieci Mesh z dynamicznym wyliczaniem dystansu i kierunku.
* 🔄 **Automatyczne Aktualizacje OTA:** Zintegrowana obsługa aktualizacji z poziomu aplikacji pobierająca najnowsze wydania instalatorów APK z GitHub Releases.

---

## 📐 Architektura Systemu

```mermaid
flowchart TD
    subgraph UI ["Warstwa Interfejsu (React + TypeScript)"]
        ReactUI["React 18 / Tailwind Design System"]
        Hooks["Custom Hooks (useMesh, useChats, useTheme)"]
    end

    subgraph Core ["Warstwa Logiki (Rust Core - Tauri v2)"]
        TauriCmds["Tauri Commands & State Management"]
        Crypto["Moduł Kryptografii (Ed25519 + SHA-256)"]
        Updater["GitHub Auto-Updater"]
    end

    subgraph Native ["Warstwa Natywna (Kotlin Android)"]
        BleMgr["BleManager (GATT Server & Client)"]
        Chunker["BLE Chunking Engine"]
        JNIBridge["JNI Most Dwukierunkowy"]
    end

    ReactUI <--> Hooks
    Hooks <--> TauriCmds
    TauriCmds <--> Crypto
    TauriCmds <--> Updater
    TauriCmds <--> JNIBridge
    JNIBridge <--> BleMgr
    BleMgr <--> Chunker
```

---

## 🔄 Protokół Fragmentacji BLE

Aby zapewnić transmisję długich wiadomości bez zależności od konkretnego rozmiaru MTU, aplikacja stosuje własne ramki:

```
+-------------------+-------------------+-------------------+-------------------+------------------------+
| 1B: Marker (0x00) | 2B: Message ID    | 1B: Total Chunks  | 1B: Chunk Index   | Max 16B: Payload Data  |
+-------------------+-------------------+-------------------+-------------------+------------------------+
```

`Message ID` jest 16-bitowym, rosnącym licznikiem. Po odebraniu bufor jest identyfikowany przez `(adres urządzenia, Message ID)`, dzięki czemu dwa równoległe komunikaty od tego samego urządzenia nie korzystają z jednego bufora. Niedokończone bufory są automatycznie usuwane po 30 sekundach.

---

## 🚀 Automatyczny Proces Wydawania Wersji (CI/CD)

W projekcie skonfigurowano **GitHub Actions** (`.github/workflows/release.yml`), które automatycznie buduje zoptymalizowane pod procesory `AArch64` pliki `.apk` przy każdym nowym tagu wersji.

### Wydanie Nowej Wersji w 3 Krokach:

1. **Zwiększ wersję** w plikach `package.json` oraz `src-tauri/tauri.conf.json` (np. na `0.0.2`).
2. **Commit & Push** zmian do gałęzi `main`.
3. **Stwórz i wyślij Tag:**
   ```bash
   git tag v0.0.2
   git push origin v0.0.2
   ```

W ciągu kilku minut GitHub Actions zbuduje instalator `Void.apk` i opublikuje go w zakładce `Releases`. Urządzenia z zainstalowaną aplikacją automatycznie wyświetlą banner z prośbą o aktualizację.

---

## 🛠️ Budowanie Lokalne

### Wymagania:
* Node.js v20+
* Rust (wersja stable z docelowymi architekturami androida)
* Android SDK & NDK (v27)

### Komendy:
```bash
# Instalacja zależności
npm install

# Kompilacja warstwy Frontendowej
npm run build

# Budowanie pakietu Android APK
npm run tauri android build -- --target aarch64
```

---

## 📄 Licencja

Projekt objęty licencją **Open Source (Non-Commercial)**.

Każdy użytkownik ma prawo do swobodnego pobierania, kopiowania, modyfikowania, rozwijania i tworzenia własnych wersji tego oprogramowania, **pod warunkiem, że aplikacja oraz jej modyfikacje NIGDY nie będą wykorzystywane w celach komercyjnych, płatnych lub odpłatnie dystrybuowane**.
