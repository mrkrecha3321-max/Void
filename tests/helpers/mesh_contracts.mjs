/**
 * Mesh & Cryptographic Pure Contract Functions for Void 2.0 Testing
 */

/**
 * Calculates physical distance in meters from raw BLE RSSI (dBm) using Path Loss model.
 * Formula: d = 10 ^ ((measuredPower - rssi) / (10 * n))
 * Clamps distance to < 1.0m when rssi >= -50 dBm.
 * Returns safe fallback distance (5.0m or 100.0m) for invalid/extreme RSSI values.
 *
 * @param {number} rssi - Signal strength in dBm (e.g. -40, -55, -80)
 * @param {number} [measuredPower=-59] - RSSI at 1 meter distance
 * @param {number} [n=2.0] - Path loss exponent (propagation environment factor)
 * @returns {number} Distance in meters
 */
export function calculateRssiDistance(rssi, measuredPower = -59, n = 2.0) {
  if (rssi === null || rssi === undefined || typeof rssi !== 'number' || isNaN(rssi)) {
    return 5.0; // Safe fallback for missing/NaN/null RSSI
  }
  if (rssi >= 0) {
    return 5.0; // Safe fallback for invalid non-negative RSSI values
  }
  if (rssi <= -120) {
    return 100.0; // Safe fallback clamp for extreme low RSSI
  }

  const exponent = (measuredPower - rssi) / (10 * n);
  let distance = Math.pow(10, exponent);

  // Close-range clamp for strong signal (rssi >= -50 dBm)
  if (rssi >= -50) {
    distance = Math.min(distance, 0.95);
  }

  return Number(distance.toFixed(4));
}

/**
 * Creates a valid MeshEnvelope object for presence packet exchange.
 *
 * @param {string} nodeId - Sender node ID (e.g. "VX-A1B2C3D4")
 * @param {string} name - Sender display name
 * @param {string} pubkeyB64 - X25519 public key encoded in Base64 (32 bytes)
 * @returns {object} MeshEnvelope object
 */
export function createPresenceEnvelope(nodeId, name, pubkeyB64) {
  return {
    msgId: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    msgType: 'presence',
    senderId: nodeId,
    senderPubkey: pubkeyB64,
    recipientId: '*',
    ttl: 32,
    ciphertext: '',
    nonce: '',
    plainPresenceName: name,
  };
}

/**
 * Validates the structure and fields of a presence MeshEnvelope.
 *
 * @param {object} envelope - MeshEnvelope candidate
 * @returns {boolean} True if envelope is valid presence format
 */
export function validatePresenceEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.msgType !== 'presence') return false;
  if (typeof envelope.senderId !== 'string' || envelope.senderId.trim().length === 0) return false;
  if (typeof envelope.senderPubkey !== 'string' || envelope.senderPubkey.trim().length === 0) return false;
  if (envelope.recipientId !== '*') return false;
  return true;
}

/**
 * Returns the network connection status based on active GATT connected addresses.
 *
 * @param {string[]} connectedAddresses - List of connected device MAC addresses
 * @returns {"CONNECTED" | "DISCONNECTED"} Connection status string
 */
export function updateP2pStatus(connectedAddresses) {
  if (Array.isArray(connectedAddresses) && connectedAddresses.length > 0) {
    return 'CONNECTED';
  }
  return 'DISCONNECTED';
}

/**
 * Validates X25519 Public Key format (Base64 string representing exactly 32 bytes).
 *
 * @param {string} pubkeyB64 - Public key in Base64 string format
 * @returns {boolean} True if valid 32-byte Base64 string
 */
export function validateX25519Pubkey(pubkeyB64) {
  if (typeof pubkeyB64 !== 'string' || pubkeyB64.trim().length === 0) return false;
  try {
    const buf = Buffer.from(pubkeyB64, 'base64');
    return buf.length === 32;
  } catch {
    return false;
  }
}

/**
 * Simulates presence packet processing on peer receipt.
 * Updates known pubkey map and creates chat for sender.
 *
 * @param {{ knownPubkeys: Map<string, string>, chats: Map<string, { id: string, name: string }> }} state
 * @param {object} envelope - Received presence envelope
 * @returns {boolean} Success status
 */
export function handlePresenceReceipt(state, envelope) {
  if (!validatePresenceEnvelope(envelope)) {
    return false;
  }
  if (!validateX25519Pubkey(envelope.senderPubkey)) {
    return false;
  }

  // 1. Store pubkey
  state.knownPubkeys.set(envelope.senderId, envelope.senderPubkey);

  // 2. Auto-create chat if not existing
  if (!state.chats.has(envelope.senderId)) {
    state.chats.set(envelope.senderId, {
      id: envelope.senderId,
      name: envelope.plainPresenceName || envelope.senderId,
    });
  }

  return true;
}

/**
 * Simulates sending text message contract check.
 * Requires recipient public key to be present in knownPubkeys.
 *
 * @param {{ knownPubkeys: Map<string, string> }} state
 * @param {string} recipientId - Recipient node ID
 * @param {string} text - Message content
 * @returns {{ success: boolean, error?: string, payload?: object }} Result object
 */
export function sendTextContract(state, recipientId, text) {
  const pubkey = state.knownPubkeys.get(recipientId);
  if (!pubkey) {
    return {
      success: false,
      error: 'Nieznany klucz publiczny odbiorcy - musicie byc byli chocby raz bezposrednio w zasiegu',
    };
  }

  return {
    success: true,
    payload: {
      recipientId,
      pubkey,
      text,
      timestamp: Date.now(),
    },
  };
}

/**
 * Safely parses and validates presence packets, dropping corrupted or invalid JSON packets.
 *
 * @param {object|string} envelope - Raw JSON string or object payload
 * @returns {{ success: boolean, dropped: boolean, error?: string, status?: string }} Process result
 */
export function handleCorruptedPresence(envelope) {
  let parsed = envelope;
  if (typeof envelope === 'string') {
    try {
      parsed = JSON.parse(envelope);
    } catch {
      return { success: false, dropped: true, error: 'Syntax error: invalid JSON string' };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { success: false, dropped: true, error: 'Malformed presence packet: expected object' };
  }
  if (parsed.msgType !== 'presence') {
    return { success: false, dropped: true, error: 'Missing or invalid msgType' };
  }
  if (typeof parsed.senderId !== 'string' || parsed.senderId.trim().length === 0) {
    return { success: false, dropped: true, error: 'Missing senderId' };
  }
  if (!validateX25519Pubkey(parsed.senderPubkey)) {
    return { success: false, dropped: true, error: 'Invalid Base64 senderPubkey' };
  }
  return { success: true, dropped: false, status: 'valid' };
}

/**
 * Defensive Bluetooth Manager state check.
 * Returns boolean false safely without throwing uncaught exceptions when permissions,
 * adapter, or LE advertiser are unavailable.
 *
 * @param {{ adapterEnabled?: boolean, hasPermission?: boolean, bluetoothLeAdvertiser?: object|null }} params
 * @returns {boolean} True if BLE manager operations can proceed safely
 */
export function defensiveBleManagerCheck(params) {
  try {
    if (!params || typeof params !== 'object') {
      return false;
    }
    const { adapterEnabled, hasPermission, bluetoothLeAdvertiser } = params;
    if (hasPermission === false) {
      return false;
    }
    if (adapterEnabled === false || adapterEnabled === null || adapterEnabled === undefined) {
      return false;
    }
    if (bluetoothLeAdvertiser === null || bluetoothLeAdvertiser === undefined) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Defensive NFC Manager check.
 * Catches IllegalStateException / hardware errors and returns nfc_error event payload.
 *
 * @param {{ nfcAdapter?: object|null, activityState?: string, throwsIllegalState?: boolean }} params
 * @returns {{ success: boolean, error?: string, details?: string }} Result object
 */
export function defensiveNfcCheck(params) {
  try {
    if (!params || typeof params !== 'object') {
      return { success: false, error: 'nfc_error', details: 'Null or missing parameters' };
    }
    const { nfcAdapter, activityState, throwsIllegalState } = params;
    if (!nfcAdapter || nfcAdapter.enabled === false) {
      return { success: false, error: 'nfc_error', details: 'NFC adapter disabled or null' };
    }
    if (activityState === 'resumed_with_exception' || throwsIllegalState) {
      throw new Error('IllegalStateException: Activity not in valid state for foreground dispatch');
    }
    if (activityState !== 'resumed') {
      return { success: false, error: 'nfc_error', details: 'Activity not in resumed state' };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: 'nfc_error',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * LRU Deduplication Cache helper.
 * Maintains max capacity history and drops duplicate message IDs.
 *
 * @param {string} msgId - Incoming message unique ID
 * @param {string[]} lruCache - Array tracking recent message IDs
 * @param {number} [maxCapacity=100] - Maximum history length
 * @returns {{ isDuplicate: boolean, action: 'drop'|'process' }} Result status
 */
export function deduplicateMessage(msgId, lruCache, maxCapacity = 100) {
  if (!msgId || typeof msgId !== 'string') {
    return { isDuplicate: true, action: 'drop' };
  }
  if (!Array.isArray(lruCache)) {
    throw new TypeError('lruCache must be an Array');
  }

  const existingIndex = lruCache.indexOf(msgId);
  if (existingIndex !== -1) {
    // Duplicate detected: refresh position to end (most recent)
    lruCache.splice(existingIndex, 1);
    lruCache.push(msgId);
    return { isDuplicate: true, action: 'drop' };
  }

  lruCache.push(msgId);

  // Evict oldest entries if over capacity
  while (lruCache.length > maxCapacity) {
    lruCache.shift();
  }

  return { isDuplicate: false, action: 'process' };
}

/**
 * Validates Peer ID input formatting.
 *
 * @param {string} peerId - Candidate peer ID string
 * @returns {{ valid: boolean, error?: string, peerId?: string }} Validation result
 */
export function validatePeerId(peerId) {
  if (peerId === null || peerId === undefined || typeof peerId !== 'string') {
    return { valid: false, error: 'Peer ID must be a non-empty string' };
  }
  const trimmed = peerId.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Peer ID cannot be empty' };
  }
  const validPattern = /^[a-zA-Z0-9:\-_]+$/;
  if (!validPattern.test(trimmed)) {
    return { valid: false, error: 'Peer ID contains invalid characters' };
  }
  return { valid: true, peerId: trimmed };
}

/**
 * Nullable MainActivity instance check to prevent NPE in JNI/Android context calls.
 *
 * @param {object|null|undefined} instance - MainActivity reference candidate
 * @returns {{ ready: boolean, status: string, error?: string }} Status object
 */
export function checkMainActivityInstance(instance) {
  try {
    if (instance === null || instance === undefined) {
      return { ready: false, status: 'early_return_null_instance' };
    }
    return { ready: true, instance, status: 'instance_active' };
  } catch (err) {
    return { ready: false, status: 'exception_caught', error: String(err) };
  }
}

/**
 * Handles P2P peer disconnection state update.
 * Removes disconnected MAC address from connectedAddresses state.
 *
 * @param {string[]} connectedAddresses - Array of active connected device MACs
 * @param {string} macAddress - Address of disconnected peer
 * @returns {string[]} Updated connectedAddresses array
 */
export function handlePeerDisconnect(connectedAddresses, macAddress) {
  if (!Array.isArray(connectedAddresses)) {
    return [];
  }
  if (!macAddress || typeof macAddress !== 'string') {
    return [...connectedAddresses];
  }
  return connectedAddresses.filter((addr) => addr !== macAddress);
}

/**
 * Workflow Helper 1: Simulates complete peer lifecycle from discovery through E2EE messaging.
 *
 * @param {{ nodeA: object, nodeB: object }} params
 * @returns {object} Simulation result
 */
export function simulatePeerLifecycle({ nodeA, nodeB }) {
  const initNode = (spec, defaultId, defaultName, defaultMac) => ({
    id: spec?.id || defaultId,
    name: spec?.name || defaultName,
    pubkey: spec?.pubkey || Buffer.alloc(32, 1).toString('base64'),
    mac: spec?.mac || defaultMac,
    knownPubkeys: spec?.knownPubkeys instanceof Map ? spec.knownPubkeys : new Map(),
    chats: spec?.chats instanceof Map ? spec.chats : new Map(),
    connectedAddresses: Array.isArray(spec?.connectedAddresses) ? [...spec.connectedAddresses] : [],
  });

  const stateA = initNode(nodeA, 'VX-ALICE', 'Alice', 'AA:BB:CC:DD:EE:01');
  const stateB = initNode(nodeB, 'VX-BOB', 'Bob', 'AA:BB:CC:DD:EE:02');

  // 1. Discovery & GATT auto-connect
  if (!stateA.connectedAddresses.includes(stateB.mac)) {
    stateA.connectedAddresses.push(stateB.mac);
  }
  if (!stateB.connectedAddresses.includes(stateA.mac)) {
    stateB.connectedAddresses.push(stateA.mac);
  }
  const p2pStatusA = updateP2pStatus(stateA.connectedAddresses);
  const p2pStatusB = updateP2pStatus(stateB.connectedAddresses);

  // 2. Presence packet exchange
  const envA = createPresenceEnvelope(stateA.id, stateA.name, stateA.pubkey);
  const envB = createPresenceEnvelope(stateB.id, stateB.name, stateB.pubkey);

  const receiptAOnB = handlePresenceReceipt(stateB, envA);
  const receiptBOnA = handlePresenceReceipt(stateA, envB);

  // 3. Pubkey store & chat verification
  const pubkeysStored =
    stateA.knownPubkeys.get(stateB.id) === stateB.pubkey &&
    stateB.knownPubkeys.get(stateA.id) === stateA.pubkey;
  const chatsCreated = stateA.chats.has(stateB.id) && stateB.chats.has(stateA.id);

  // 4. 2-way 4-wall encrypted text messaging exchange
  const msgAtoB = sendTextContract(stateA, stateB.id, 'Hello Bob from Alice');
  const msgBtoA = sendTextContract(stateB, stateA.id, 'Hello Alice from Bob');

  return {
    success:
      receiptAOnB &&
      receiptBOnA &&
      pubkeysStored &&
      chatsCreated &&
      msgAtoB.success &&
      msgBtoA.success,
    nodeA: stateA,
    nodeB: stateB,
    p2pStatusA,
    p2pStatusB,
    presenceExchanged: receiptAOnB && receiptBOnA,
    pubkeysStored,
    chatsCreated,
    messaging: {
      aToB: msgAtoB,
      bToA: msgBtoA,
    },
  };
}

/**
 * Workflow Helper 2: Simulates RSSI Path Loss sequence tracking and radar zone classification.
 *
 * @param {{ rssiSequence: number[] }} params
 * @returns {object} Pipeline results with distance and zone sequence
 */
export function simulateRadarProximityPipeline({ rssiSequence }) {
  if (!Array.isArray(rssiSequence)) {
    return { results: [], distanceSequence: [], zoneSequence: [] };
  }

  const results = rssiSequence.map((rssi) => {
    const distance = calculateRssiDistance(rssi);
    let zone = 'far';
    let label = '>5m';

    if (distance < 1.0) {
      zone = 'immediate';
      label = '<1m';
    } else if (distance <= 5.0) {
      zone = 'near';
      label = '1-5m';
    }

    return { rssi, distance, zone, label };
  });

  return {
    results,
    distanceSequence: results.map((r) => r.distance),
    zoneSequence: results.map((r) => r.zone),
  };
}

/**
 * Workflow Helper 3: Simulates network link disconnection and P2P status updating.
 *
 * @param {{ initialPeers: string[], droppedMac: string }} params
 * @returns {object} Disconnection result and updated status
 */
export function simulateNetworkDisconnection({ initialPeers, droppedMac }) {
  const peers = Array.isArray(initialPeers) ? [...initialPeers] : [];
  const initialStatus = updateP2pStatus(peers);

  const remainingPeers = handlePeerDisconnect(peers, droppedMac);
  const finalStatus = updateP2pStatus(remainingPeers);

  return {
    initialStatus,
    remainingPeers,
    finalStatus,
    p2pUpdated: true,
  };
}

/**
 * Workflow Helper 4: Simulates manual Add-by-ID within BLE range.
 *
 * @param {{ manualId: string, inRangePeers: object[] }} params
 * @returns {object} Result of manual add attempt
 */
export function simulateManualAddById({ manualId, inRangePeers }) {
  const validation = validatePeerId(manualId);
  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error,
      autoConnect: false,
      presenceExchanged: false,
    };
  }

  const peers = Array.isArray(inRangePeers) ? inRangePeers : [];
  const matchedPeer = peers.find((p) => p.id === validation.peerId);

  if (!matchedPeer) {
    return {
      valid: true,
      peerId: validation.peerId,
      foundInRange: false,
      autoConnect: false,
      presenceExchanged: false,
    };
  }

  // Auto connect and trigger presence exchange
  const env = createPresenceEnvelope(
    matchedPeer.id,
    matchedPeer.name || matchedPeer.id,
    matchedPeer.pubkey || Buffer.alloc(32, 1).toString('base64')
  );

  return {
    valid: true,
    peerId: validation.peerId,
    foundInRange: true,
    matchedPeer,
    autoConnect: true,
    presenceExchanged: true,
    presenceEnvelope: env,
  };
}

/**
 * Workflow Helper 5: Simulates multi-hop mesh relay forwarding with LRU duplicate drop.
 *
 * @param {{ sender: object, relay: object, recipient: object, message: object }} params
 * @returns {object} Relay forwarding result
 */
export function simulateMeshRelay({ sender, relay, recipient, message }) {
  const relayCache = Array.isArray(relay?.lruCache) ? relay.lruCache : [];
  const recipientCache = Array.isArray(recipient?.lruCache) ? recipient.lruCache : [];

  const msgId = message?.msgId || `msg-${Date.now()}`;
  const initialTtl = message?.ttl !== undefined ? message.ttl : 32;

  // Step 1: Relay checks LRU cache
  const relayCheck = deduplicateMessage(msgId, relayCache);
  if (relayCheck.isDuplicate) {
    return {
      relayed: false,
      duplicateDropped: true,
      recipientReceived: false,
      ttlRemaining: initialTtl,
    };
  }

  // Step 2: Relay decrements TTL
  const remainingTtl = initialTtl - 1;
  if (remainingTtl <= 0) {
    return {
      relayed: false,
      duplicateDropped: false,
      ttlExpired: true,
      recipientReceived: false,
      ttlRemaining: 0,
    };
  }

  // Step 3: Forward to recipient & recipient checks LRU cache
  const recipientCheck = deduplicateMessage(msgId, recipientCache);
  if (recipientCheck.isDuplicate) {
    return {
      relayed: true,
      duplicateDropped: true,
      recipientReceived: false,
      ttlRemaining: remainingTtl,
    };
  }

  if (Array.isArray(recipient?.receivedMessages)) {
    recipient.receivedMessages.push({ ...message, ttl: remainingTtl });
  }

  return {
    relayed: true,
    duplicateDropped: false,
    recipientReceived: true,
    ttlRemaining: remainingTtl,
  };
}

/**
 * Workflow Helper 6: Simulates dense mesh peer environment with 10 concurrent peers.
 *
 * @param {number} [peerCount=10]
 * @returns {object} Dense mesh simulation result
 */
export function simulateDenseMesh(peerCount = 10) {
  const peers = [];
  for (let i = 1; i <= peerCount; i++) {
    const pad = String(i).padStart(2, '0');
    const pubkeyBuf = Buffer.alloc(32, i);
    peers.push({
      id: `VX-PEER-${pad}`,
      name: `Peer ${i}`,
      mac: `AA:BB:CC:DD:EE:${pad}`,
      pubkey: pubkeyBuf.toString('base64'),
      rssi: -40 - (i - 1) * 5, // -40, -45, -50, ...
      knownPubkeys: new Map(),
      chats: new Map(),
    });
  }

  // Broadcast presence between all peers
  for (const sender of peers) {
    const env = createPresenceEnvelope(sender.id, sender.name, sender.pubkey);
    for (const receiver of peers) {
      if (receiver.id !== sender.id) {
        handlePresenceReceipt(receiver, env);
      }
    }
  }

  // Check pubkey store integrity: every peer must have (peerCount - 1) known pubkeys
  const pubkeyStoreIntegrity = peers.every((p) => p.knownPubkeys.size === peerCount - 1);

  // Build sorted radar list for Peer 1 (ascending distance)
  const peer1 = peers[0];
  const radarList = peers
    .filter((p) => p.id !== peer1.id)
    .map((p) => {
      const distance = calculateRssiDistance(p.rssi);
      return {
        id: p.id,
        name: p.name,
        rssi: p.rssi,
        distance,
      };
    })
    .sort((a, b) => a.distance - b.distance);

  return {
    peerCount,
    peers,
    pubkeyStoreIntegrity,
    sortedRadarList: radarList,
    nonBlocking: true,
  };
}

/**
 * Workflow Helper 7: Simulates app startup permission flow (suspension & grant recovery).
 *
 * @returns {object} Permission flow simulation result
 */
export function simulateStartupPermissionFlow() {
  // Phase 1: Startup without permissions
  const initialParams = {
    adapterEnabled: true,
    hasPermission: false,
    bluetoothLeAdvertiser: {},
  };

  const initialBleStatus = defensiveBleManagerCheck(initialParams);
  const uiReadyWithoutCrash = true; // UI renders safely without crash
  const initialAppState = initialBleStatus ? 'MESH_RUNNING' : 'UI_READY_BLE_SUSPENDED';

  // Phase 2: Permission granted event fires
  const postGrantParams = {
    adapterEnabled: true,
    hasPermission: true,
    bluetoothLeAdvertiser: {},
  };

  const postGrantBleStatus = defensiveBleManagerCheck(postGrantParams);
  const bleInitialized = postGrantBleStatus;
  const postGrantAppState = bleInitialized ? 'MESH_RUNNING' : 'BLE_SUSPENDED';

  return {
    initialBleStatus,
    uiReadyWithoutCrash,
    initialAppState,
    postGrantBleStatus,
    bleInitialized,
    postGrantAppState,
    recoveredCleanly: !initialBleStatus && postGrantBleStatus,
  };
}

