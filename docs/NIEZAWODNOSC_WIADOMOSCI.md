# Niezawodność wiadomości — transport BLE, trwały inbox i retry

Ten dokument opisuje zmiany wprowadzone w celu niezawodnego wysyłania i
odbierania wiadomości bez Wi‑Fi / danych komórkowych. Jest uzupełnieniem
`README.md` i opisuje stan kodu, a nie plan.

## 1. Trwały inbox przed ACK

Odbiór wiadomości tekstowej (`mesh.rs::handle_incoming`, gałąź `"text"`):

1. Koperta jest weryfikowana kryptograficznie (podpis Ed25519, walidacja pól).
2. Tekst jest odszyfrowywany AEAD.
3. **Najpierw** rekord jest zapisywany w zaszyfrowanym inboxie
   (`SecureStore::inbox_put` w `storage.rs`). Inbox jest częścią tego samego
   zaszyfrowanego vaultu co piny i outbox.
4. Dopiero po sukcesie zapisu:
   - emitowany jest event `message_received` do WebView,
   - wysyłany jest podpisany ACK.
5. Błąd zapisu oznacza **brak ACK** — nadawca ponawia wiadomość (outbox).
6. Duplikat o tym samym `msgId` (np. po utraconym ACK) jest idempotentny:
   - `inbox_put` zwraca `false` i nie tworzy drugiego rekordu,
   - ACK jest wysyłany ponownie, ale event do UI nie jest powtarzany.

Frontend (`hooks/useChats.ts`) po hydracji historii oraz przy powrocie aplikacji
na pierwszy plan wywołuje `drain_inbox`, scala wiadomości do stanu i zapisuje
zaszyfrowaną historię, a dopiero potem potwierdza rekordy przez `ack_inbox`.
Dzięki temu crash pomiędzy odczytem inboxu a zapisem historii nie gubi
wiadomości — rekordy zostaną ponownie zwrócone przy kolejnym uruchomieniu.

Nowe komendy Tauri:
- `drain_inbox` -> lista `{id, peerId, text, timestamp}`;
- `ack_inbox(ids)` -> trwale usuwa potwierdzone rekordy.

## 2. Outbox, retry i stany transmisji

Każda wychodząca wiadomość tekstowa jest zapisywana w zaszyfrowanym outboxie
(`OutboxRecord`) **przed** pierwszym przekazaniem do BLE i usuwana dopiero po
otrzymaniu podpisanego ACK od odbiorcy.

Pola rekordu:
- `created_at_ms`, `last_attempt_ms`, `attempt_count`, `in_flight`.

Stany (frontend pokazuje je na bąblu):
- `queued` — oczekuje na transmisję;
- `transmitting` — BLE aktywnie wysyła ramki (wewnętrzne, synchronizowane przez
  `in_flight`);
- `transport_sent` — ostatnia ramka została zapisana przez GATT (pojedynczy
  znacznik w UI);
- `delivered` — otrzymano podpisany ACK (podwójny znacznik);
- `failed` — wyczerpano próby/TTL lub wystąpił twardy błąd transportu.

Kontrakt:
- Rust i UI nie traktują dodania do kolejki jako wysłania.
- `message_transport_sent` jest emitowany dopiero, gdy natywny BLE zapisze
  **ostatnią** ramkę całej wiadomości (patrz `BleManager.completeFrame`).
- `message_transport_failed` jest emitowany po ostatecznym błędzie, rozłączeniu
  w trakcie transmisji lub timeoutcie ramki.
- `mark_outbox_in_flight` atomowo zajmuje wiadomość — równoległy flush/ponów
  nie zakolejkuje tej samej wiadomości dwa razy.

Retry:
- po niepowodzeniu GATT następuje wznowienie od pierwszej ramki;
- `next_attempt_delay_ms` to wykładniczy backoff (2s, 4s, 8s, …, maks. 15 min);
- po `transport_sent` wiadomość czeka na ACK; brak ACI uruchamia watchdog UI;
- `flush_outbox` jest wywoływany cyklicznie co 5 s, po `onPeerConnected` oraz
  niezwłocznie po `transport_failed`.

Stare rekordy outboxu są czyszczone przez `prune_outbox` (TTL 24 h, maks. 8
prób).

## 3. BLE w tle (foreground service)

`BleForegroundService` (typ `connectedDevice`) utrzymuje proces przy życiu, gdy
UI jest w tle lub ekran jest wygaszony:
- tworzy niskopriorytetowe, trwałe powiadomienie w kanale `void_ble_service`;
- na Androidzie 14 (API 34) używa `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`
  oraz wymaga uprawnienia `FOREGROUND_SERVICE_CONNECTED_DEVICE` z manifestu;
- uruchamiany jest z `MainActivity` po przyznaniu uprawnień BLE;
- nie obchodzi ograniczeń Androida — jeśli system nie pozwoli wystartować
  (wyjątek `ForegroundServiceStartNotAllowed`), BLE działa dalej oportunistycznie
  i service jest restartowany po powrocie UI.

Skanowanie/reklama/GATT są własnością `BleManager`; usługa tylko podnosi priorytet
procesu i w `onStartCommand` próbuje wznowić skanowanie/reklamę po zmianie stanu
Bluetooth.

## 4. Mapowanie transmisji i ramek

- Rust przekazuje pełne `msgId` (UUID) do warstwy JNI (`send_message(...,
  Option<mesh_msg_id>)`).
- `BleManager` przypisuje transmisji 16‑bitowe `linkId` (zawijane), koduje
  wszystkie ramki tej samej wiadomości tym samym linkId i wywołuje
  `NativeBridge.onTransportSent(meshMsgId)` dopiero po zapisaniu ostatniej ramki.
- Błąd/timeout dowolnej ramki po 3 próbach ko transmisję i wywołuje
  `onTransportFailed(meshMsgId, reason)`.

## 5. MTU i fragmentacja

`BleFrameCodec` oblicza ładowność ramki z wynegocjowanego MTU:

```
payloadCapacity = mtu - 3 (ATT) - 5 (nagłówek ramki)
```

- Inicjator połączenia woła `requestMtu(517)`; wartość jest obcinana do
  `[23, 517]` i zapamiętywana per adres w `negotiatedMtu`.
- Nadawca używa `encode(message, linkId, mtu)`; odbiorca akceptuje dowolną
  poprawną ramkę o długości do `maxPayloadForMtu(MAX_MTU)`, więc miesza linki
  23/185/247/512 ze sobą współpracują.
- Maks. liczba ramek 255; maks. koperta to 4080 B w warstwie meshu.

## 6. Statusy UI i lifecycle

- Wykrycie reklamy (`ble_peer_discovered`) **nie** ustawia peera na online —
  online oznacza ustanowione GATT i podpisane presence.
- Nagłówek czatu pokazuje stan konkretnego peera (`peerOnline`), a nie zieloną
  kropkę na stałe.
- `useMesh` używa guardów (`meshStartingRef`, `meshStartedRef`), by uniknąć
  podwójnego `startMesh` po przyznaniu uprawnień.
- Rozłączenie czyści kolejki zapisu, timeouty, bufory odbioru i stan in-flight
  oraz planuje reconnect z wykładniczym opóźnieniem.

## 7. Build developerski a release

- Release APK używa wbudowanego `frontendDist` (`../dist`) i nie wymaga
  `devUrl` ani dostępu do sieci.
- `tauri android dev` korzysta z Vite (`devUrl`) tylko w debugowaniu; to
  oczekiwane i nie wpływa na release.

## Ograniczenia wymagające fizycznych telefonów

- Zachowanie skanera BLE w trybie Doze / battery optimization różni się między
  producentami (Samsung, Xiaomi itp.) — wymaga testu na urządzeniach.
- Foreground service nie zastępuje wykluczenia aplikacji z optymalizacji baterii.
- Negocjacja MTU i zachowanie GATT per model wymaga potwierdzenia sprzętowego.
