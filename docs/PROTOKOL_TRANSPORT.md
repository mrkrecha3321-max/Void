# Protokół transportu VOID

Dokument opisuje framing BLE v2 oraz cykl życia wiadomości od odbioru do ACK. Warstwa mesh (podpis Ed25519, szyfrowanie E2EE, walidacja kopert) nie uległa osłabieniu.

## Framing BLE

Każda koperta mesh jest zawsze ramkowana, również gdy mieści się w jednym fragmencie.

### v1 (legacy, marker `0x00`)

```text
+--------+------------+------------+------------+------------------+
| 1B 0x00| 2B msg id  | 1B total   | 1B index   | payload <= 16 B  |
+--------+------------+------------+------------+------------------+
```

Odbiorca nadal akceptuje poprawne ramki v1.

### v2 (marker `0x01`)

```text
+--------+------------+------------+------------+---------------------------+
| 1B 0x01| 2B msg id  | 2B total   | 2B index   | payload = MTU - 3 - 7     |
+--------+------------+------------+------------+---------------------------+
```

- narzut ATT: 3 bajty,
- nagłówek v2: 7 bajtów,
- rozmiar payloadu wynika z faktycznie wynegocjowanego MTU, nie ze stałej 16,
- ramka nigdy nie przekracza `MTU - 3`,
- maksymalny rozmiar koperty transportowej: 4080 B,
- maksymalna liczba fragmentów v2: 2048,
- kolejny fragment jest wysyłany dopiero po callbacku poprzedniego,
- ramka ma timeout i ograniczony retry; błąd środkowego fragmentu przerywa tylko tę wiadomość.

Domyślne MTU przed negocjacją to 23. `requestMtu(512)` jest żądaniem, nie gwarancją.

## Cykl odbioru wiadomości tekstowej

1. Kotlin składa ramki i przekazuje kompletną kopertę do Rust.
2. Rust weryfikuje podpis, typ, czas, rozmiar i odszyfrowuje tekst.
3. Odszyfrowana wiadomość jest zapisywana w szyfrowanym inboxie vault **zanim** wyjdzie ACK.
4. Dopiero po udanym zapisie `msgId` trafia do replay cache i emitowane jest `message_received`.
5. ACK jest podpisaną kopertą mesh i oznacza dostarczenie do odbiorcy, nie sam zapis w kolejce BLE.
6. Frontend przy starcie i po powrocie z tła wywołuje `list_pending_inbox`.
7. Po zapisaniu historii wywołuje `confirm_inbox`. Rekord znika z inboxu tylko wtedy, gdy ten sam `msgId` jest już w historii.
8. Duplikat po utraconym ACK dostaje ponowne ACK wyłącznie, gdy wiadomość jest w inboxie albo historii.

Błąd zapisu inboxu = brak ACK i brak `mark_seen`. Nadawca może ponowić.

## Cykl wysyłki

Stany: `queued` → `transmitting` → `transport_sent` → `delivered` / `failed`.

- `sendMessage` / `relay` oznaczają tylko przyjęcie do kolejki BLE powiązanej z pełnym mesh `msgId`.
- `transport_sent` jest emitowane po poprawnym wysłaniu **ostatniego** fragmentu.
- `transport_failed` ma `msgId` i przyczynę.
- Outbox trzyma podpisaną kopertę do zweryfikowanego ACK.
- Retry używa `lastAttemptAt`, `attemptCount`, `inFlight`, exponential backoff i limitu prób.
- Ta sama wiadomość nie jest dokładana do kolejki, gdy poprzednia próba trwa.

## Działanie w tle

BLE jest utrzymywane przez `MeshForegroundService` typu `connectedDevice` w tym samym procesie co Tauri.

Powód: Rust, vault i WebView żyją w procesie aplikacji. Osobny proces `:mesh` nie miałby dostępu do `MeshState`. Oficjalnie wspieranym mechanizmem jest więc FGS `connectedDevice` z widocznym powiadomieniem, a nie obchodzenie limitów Androida 8–16.

Po restarcie procesu service odtwarza advertising/skan z zapisanego publicznego Node ID. Kompletne koperty odebrane zanim Rust wstanie lądują w plikach `pending_rx` i są odtwarzane po `onRustReady`. ACK nadal wychodzi dopiero z Rust po trwałym inboxie.

Activity nie zatrzymuje BLE w `onDestroy`.
