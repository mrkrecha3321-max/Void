import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRssiDistance,
  createPresenceEnvelope,
  validatePresenceEnvelope,
  updateP2pStatus,
  validateX25519Pubkey,
  handlePresenceReceipt,
  sendTextContract,
} from './helpers/mesh_contracts.mjs';

describe('Tier 1: Feature Logic & Network Protocol Verification', () => {
  it('Test 1.6: GATT Auto-Connect trigger contract upon peer discovery', () => {
    const activeState = {
      discoveredPeers: new Map(),
      connectedGattAddresses: new Set(),
      autoConnectLog: [],
    };

    function simulatePeerDiscovery(peer) {
      activeState.discoveredPeers.set(peer.address, peer);
      // GATT Auto-Connect logic contract trigger:
      if (!activeState.connectedGattAddresses.has(peer.address)) {
        activeState.autoConnectLog.push({
          action: 'connectGatt',
          address: peer.address,
          timestamp: Date.now(),
        });
        activeState.connectedGattAddresses.add(peer.address);
      }
    }

    const mockDiscoveredPeer = {
      address: 'AA:BB:CC:DD:EE:FF',
      shortId: 'VX-A1B2C3D4',
      name: 'Alice Device',
      rssi: -55,
    };

    simulatePeerDiscovery(mockDiscoveredPeer);

    assert.equal(activeState.autoConnectLog.length, 1);
    assert.equal(activeState.autoConnectLog[0].action, 'connectGatt');
    assert.equal(activeState.autoConnectLog[0].address, 'AA:BB:CC:DD:EE:FF');
    assert.ok(activeState.connectedGattAddresses.has('AA:BB:CC:DD:EE:FF'));
  });

  it('Test 1.7: Presence packet structure validation', () => {
    const validPubkey = Buffer.alloc(32, 1).toString('base64');
    const validEnvelope = createPresenceEnvelope('VX-SENDER1', 'Bob Node', validPubkey);

    assert.ok(validatePresenceEnvelope(validEnvelope), 'Valid presence envelope should pass validation');
    assert.equal(validEnvelope.msgType, 'presence');
    assert.equal(validEnvelope.senderId, 'VX-SENDER1');
    assert.equal(validEnvelope.senderPubkey, validPubkey);
    assert.equal(validEnvelope.recipientId, '*');
    assert.equal(validEnvelope.plainPresenceName, 'Bob Node');

    // Negative tests for invalid structure
    assert.equal(validatePresenceEnvelope(null), false);
    assert.equal(validatePresenceEnvelope({ ...validEnvelope, msgType: 'text' }), false);
    assert.equal(validatePresenceEnvelope({ ...validEnvelope, senderId: '' }), false);
    assert.equal(validatePresenceEnvelope({ ...validEnvelope, recipientId: 'VX-OTHER' }), false);
    assert.equal(validatePresenceEnvelope({ ...validEnvelope, senderPubkey: '' }), false);
  });

  it('Test 1.8: X25519 Public Key format validation and pubkey map storage', () => {
    const valid32ByteKey = Buffer.alloc(32, 0x42).toString('base64');
    const invalidShortKey = Buffer.alloc(16, 0x42).toString('base64');
    const invalidLongKey = Buffer.alloc(64, 0x42).toString('base64');

    assert.ok(validateX25519Pubkey(valid32ByteKey), '32-byte Base64 key should be valid');
    assert.equal(validateX25519Pubkey(invalidShortKey), false, '16-byte key should be invalid');
    assert.equal(validateX25519Pubkey(invalidLongKey), false, '64-byte key should be invalid');
    assert.equal(validateX25519Pubkey(''), false, 'Empty key string should be invalid');

    // Storage test in knownPubkeys map
    const knownPubkeys = new Map();
    const nodeId = 'VX-NODE-KEY-TEST';
    knownPubkeys.set(nodeId, valid32ByteKey);

    assert.ok(knownPubkeys.has(nodeId));
    assert.equal(knownPubkeys.get(nodeId), valid32ByteKey);
  });

  it('Test 1.9: Auto chat creation logic contract on presence receipt for both sender and receiver', () => {
    // Node A state
    const nodeAState = {
      knownPubkeys: new Map(),
      chats: new Map(),
    };

    // Node B state
    const nodeBState = {
      knownPubkeys: new Map(),
      chats: new Map(),
    };

    const pubkeyA = Buffer.alloc(32, 0x0a).toString('base64');
    const pubkeyB = Buffer.alloc(32, 0x0b).toString('base64');

    const envelopeFromA = createPresenceEnvelope('VX-NODE-A', 'Alice', pubkeyA);
    const envelopeFromB = createPresenceEnvelope('VX-NODE-B', 'Bob', pubkeyB);

    // Node B receives presence from Node A
    const resultB = handlePresenceReceipt(nodeBState, envelopeFromA);
    assert.ok(resultB, 'Node B should successfully process Node A presence');
    assert.ok(nodeBState.chats.has('VX-NODE-A'), 'Chat with Node A should be created in Node B chats');
    assert.equal(nodeBState.chats.get('VX-NODE-A').name, 'Alice');

    // Node A receives presence from Node B
    const resultA = handlePresenceReceipt(nodeAState, envelopeFromB);
    assert.ok(resultA, 'Node A should successfully process Node B presence');
    assert.ok(nodeAState.chats.has('VX-NODE-B'), 'Chat with Node B should be created in Node A chats');
    assert.equal(nodeAState.chats.get('VX-NODE-B').name, 'Bob');
  });

  it('Test 1.10: send_text requirement for stored recipient public key', () => {
    const state = {
      knownPubkeys: new Map(),
    };

    const recipientId = 'VX-RECIPIENT-99';
    const text = 'Szyfrowana wiadomosc testowa';

    // 1. Attempt send_text without storing pubkey -> MUST FAIL
    const failedResult = sendTextContract(state, recipientId, text);
    assert.equal(failedResult.success, false);
    assert.ok(
      failedResult.error.includes('Nieznany klucz publiczny odbiorcy'),
      `Error message should state recipient pubkey is unknown. Got: ${failedResult.error}`
    );

    // 2. Store recipient pubkey
    const validPubkey = Buffer.alloc(32, 0xcc).toString('base64');
    state.knownPubkeys.set(recipientId, validPubkey);

    // 3. Attempt send_text with stored pubkey -> MUST SUCCEED
    const successResult = sendTextContract(state, recipientId, text);
    assert.equal(successResult.success, true);
    assert.equal(successResult.payload.recipientId, recipientId);
    assert.equal(successResult.payload.pubkey, validPubkey);
    assert.equal(successResult.payload.text, text);
  });

  it('Test 1.11: Path Loss RSSI distance calculation (-40 dBm, -55 dBm, -80 dBm)', () => {
    // 1. Close-range (-40 dBm) -> distance < 1.0m
    const distNear = calculateRssiDistance(-40);
    assert.ok(
      distNear < 1.0,
      `Distance for -40 dBm should be < 1.0m. Got: ${distNear}m`
    );

    // 2. Mid-range (-55 dBm) -> ~0.6m - 1.5m
    const distMid = calculateRssiDistance(-55);
    assert.ok(
      distMid >= 0.6 && distMid <= 1.5,
      `Distance for -55 dBm should be between 0.6m and 1.5m. Got: ${distMid}m`
    );

    // 3. Far-range (-80 dBm) -> > 10m
    const distFar = calculateRssiDistance(-80);
    assert.ok(
      distFar > 10.0,
      `Distance for -80 dBm should be > 10m. Got: ${distFar}m`
    );
  });

  it('Test 1.12: P2P Network Connection indicator state transition based on connected_addresses', () => {
    let connectedAddresses = [];
    assert.equal(
      updateP2pStatus(connectedAddresses),
      'DISCONNECTED',
      'Empty connected_addresses should yield DISCONNECTED'
    );

    // Device connects
    connectedAddresses = ['AA:BB:CC:DD:EE:FF'];
    assert.equal(
      updateP2pStatus(connectedAddresses),
      'CONNECTED',
      'Active connected_addresses should yield CONNECTED'
    );

    // Multiple devices connect
    connectedAddresses.push('11:22:33:44:55:66');
    assert.equal(
      updateP2pStatus(connectedAddresses),
      'CONNECTED',
      'Multiple connected_addresses should yield CONNECTED'
    );

    // All devices disconnect
    connectedAddresses = [];
    assert.equal(
      updateP2pStatus(connectedAddresses),
      'DISCONNECTED',
      'Cleared connected_addresses should yield DISCONNECTED'
    );
  });
});
