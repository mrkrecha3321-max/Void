
export function calculateRssiDistance(rssi, measuredPower = -59, n = 2.0) {
  if (rssi === null || rssi === undefined || typeof rssi !== 'number' || isNaN(rssi)) {
    return 5.0;
  }
  if (rssi >= 0) {
    return 5.0;
  }
  if (rssi <= -120) {
    return 100.0;
  }

  const exponent = (measuredPower - rssi) / (10 * n);
  let distance = Math.pow(10, exponent);

  if (rssi >= -50) {
    distance = Math.min(distance, 0.95);
  }

  return Number(distance.toFixed(4));
}

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

export function validatePresenceEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.msgType !== 'presence') return false;
  if (typeof envelope.senderId !== 'string' || envelope.senderId.trim().length === 0) return false;
  if (typeof envelope.senderPubkey !== 'string' || envelope.senderPubkey.trim().length === 0) return false;
  if (envelope.recipientId !== '*') return false;
  return true;
}

export function updateP2pStatus(connectedAddresses) {
  if (Array.isArray(connectedAddresses) && connectedAddresses.length > 0) {
    return 'CONNECTED';
  }
  return 'DISCONNECTED';
}

export function validateX25519Pubkey(pubkeyB64) {
  if (typeof pubkeyB64 !== 'string' || pubkeyB64.trim().length === 0) return false;
  try {
    const buf = Buffer.from(pubkeyB64, 'base64');
    return buf.length === 32;
  } catch {
    return false;
  }
}

export function handlePresenceReceipt(state, envelope) {
  if (!validatePresenceEnvelope(envelope)) {
    return false;
  }
  if (!validateX25519Pubkey(envelope.senderPubkey)) {
    return false;
  }

  state.knownPubkeys.set(envelope.senderId, envelope.senderPubkey);

  if (!state.chats.has(envelope.senderId)) {
    state.chats.set(envelope.senderId, {
      id: envelope.senderId,
      name: envelope.plainPresenceName || envelope.senderId,
    });
  }

  return true;
}

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

export function deduplicateMessage(msgId, lruCache, maxCapacity = 100) {
  if (!msgId || typeof msgId !== 'string') {
    return { isDuplicate: true, action: 'drop' };
  }
  if (!Array.isArray(lruCache)) {
    throw new TypeError('lruCache must be an Array');
  }

  const existingIndex = lruCache.indexOf(msgId);
  if (existingIndex !== -1) {
    lruCache.splice(existingIndex, 1);
    lruCache.push(msgId);
    return { isDuplicate: true, action: 'drop' };
  }

  lruCache.push(msgId);

  while (lruCache.length > maxCapacity) {
    lruCache.shift();
  }

  return { isDuplicate: false, action: 'process' };
}

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

export function handlePeerDisconnect(connectedAddresses, macAddress) {
  if (!Array.isArray(connectedAddresses)) {
    return [];
  }
  if (!macAddress || typeof macAddress !== 'string') {
    return [...connectedAddresses];
  }
  return connectedAddresses.filter((addr) => addr !== macAddress);
}

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

  if (!stateA.connectedAddresses.includes(stateB.mac)) {
    stateA.connectedAddresses.push(stateB.mac);
  }
  if (!stateB.connectedAddresses.includes(stateA.mac)) {
    stateB.connectedAddresses.push(stateA.mac);
  }
  const p2pStatusA = updateP2pStatus(stateA.connectedAddresses);
  const p2pStatusB = updateP2pStatus(stateB.connectedAddresses);

  const envA = createPresenceEnvelope(stateA.id, stateA.name, stateA.pubkey);
  const envB = createPresenceEnvelope(stateB.id, stateB.name, stateB.pubkey);

  const receiptAOnB = handlePresenceReceipt(stateB, envA);
  const receiptBOnA = handlePresenceReceipt(stateA, envB);

  const pubkeysStored =
    stateA.knownPubkeys.get(stateB.id) === stateB.pubkey &&
    stateB.knownPubkeys.get(stateA.id) === stateA.pubkey;
  const chatsCreated = stateA.chats.has(stateB.id) && stateB.chats.has(stateA.id);

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

export function simulateMeshRelay({ sender, relay, recipient, message }) {
  const relayCache = Array.isArray(relay?.lruCache) ? relay.lruCache : [];
  const recipientCache = Array.isArray(recipient?.lruCache) ? recipient.lruCache : [];

  const msgId = message?.msgId || `msg-${Date.now()}`;
  const initialTtl = message?.ttl !== undefined ? message.ttl : 32;

  const relayCheck = deduplicateMessage(msgId, relayCache);
  if (relayCheck.isDuplicate) {
    return {
      relayed: false,
      duplicateDropped: true,
      recipientReceived: false,
      ttlRemaining: initialTtl,
    };
  }

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

  for (const sender of peers) {
    const env = createPresenceEnvelope(sender.id, sender.name, sender.pubkey);
    for (const receiver of peers) {
      if (receiver.id !== sender.id) {
        handlePresenceReceipt(receiver, env);
      }
    }
  }

  const pubkeyStoreIntegrity = peers.every((p) => p.knownPubkeys.size === peerCount - 1);

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

export function applyBleDiscoveryToPeer(peer, advertisement) {
  return {
    ...peer,
    id: peer.id || advertisement.shortId,
    address: advertisement.address,
    rssi: advertisement.rssi,
    linkStatus: peer.linkStatus && peer.linkStatus !== 'disconnected' ? peer.linkStatus : 'discovered',
    online: peer.linkStatus === 'ready',
  };
}

export function isRadarPeerVisible(peer, nowMs, ttlMs = 15_000) {
  if (peer.linkStatus === 'connected' || peer.linkStatus === 'ready') return true;
  return Number.isFinite(peer.lastBleSeenAt) &&
    nowMs >= peer.lastBleSeenAt &&
    nowMs - peer.lastBleSeenAt <= ttlMs;
}

export function mapPeerIdToAddress(bindings, peerId) {
  const exact = bindings.find((item) => item.peerId === peerId);
  if (exact) return exact.address;
  return null;
}

export function queueOutboundMessages(queue, messages) {
  const accepted = [];
  for (const message of messages) {
    if (queue.inFlight.has(message.msgId) || queue.items.some((item) => item.msgId === message.msgId)) {
      continue;
    }
    queue.items.push({ ...message, state: 'queued' });
    accepted.push(message.msgId);
  }
  return accepted;
}

export function simulateStartupPermissionFlow() {
  const initialParams = {
    adapterEnabled: true,
    hasPermission: false,
    bluetoothLeAdvertiser: {},
  };

  const initialBleStatus = defensiveBleManagerCheck(initialParams);
  const uiReadyWithoutCrash = true;
  const initialAppState = initialBleStatus ? 'MESH_RUNNING' : 'UI_READY_BLE_SUSPENDED';

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
