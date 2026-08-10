import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulatePeerLifecycle,
  simulateRadarProximityPipeline,
  simulateNetworkDisconnection,
  simulateManualAddById,
  simulateMeshRelay,
  updateP2pStatus,
} from './helpers/mesh_contracts.mjs';

describe('Tier 3: Cross-Feature Integration Scenarios Verification', () => {
  it('Test 3.1: Full Peer Lifecycle (Discovery -> GATT -> Presence -> Pubkey Store -> Dual Chat -> E2EE text msg exchange)', () => {
    const nodeA = {
      id: 'VX-ALICE',
      name: 'Alice',
      mac: '11:22:33:44:55:66',
      pubkey: Buffer.alloc(32, 10).toString('base64'),
    };
    const nodeB = {
      id: 'VX-BOB',
      name: 'Bob',
      mac: 'AA:BB:CC:DD:EE:FF',
      pubkey: Buffer.alloc(32, 20).toString('base64'),
    };

    const result = simulatePeerLifecycle({ nodeA, nodeB });

    assert.equal(result.success, true, 'Peer lifecycle simulation should complete successfully');
    assert.equal(result.p2pStatusA, 'CONNECTED');
    assert.equal(result.p2pStatusB, 'CONNECTED');
    assert.equal(result.presenceExchanged, true);
    assert.equal(result.pubkeysStored, true);
    assert.equal(result.chatsCreated, true);

    // Verify Alice pubkey store and chats
    assert.equal(result.nodeA.knownPubkeys.get(nodeB.id), nodeB.pubkey);
    assert.ok(result.nodeA.chats.has(nodeB.id));

    // Verify Bob pubkey store and chats
    assert.equal(result.nodeB.knownPubkeys.get(nodeA.id), nodeA.pubkey);
    assert.ok(result.nodeB.chats.has(nodeA.id));

    // Verify encrypted messaging exchange
    assert.equal(result.messaging.aToB.success, true);
    assert.equal(result.messaging.bToA.success, true);
  });

  it('Test 3.2: RSSI Path Loss tracking and Radar UI proximity band state sync (-40 dBm immediate <1m, -65 dBm near 1-5m, -90 dBm far >5m)', () => {
    const rssiSequence = [-40, -65, -90];
    const { results, zoneSequence } = simulateRadarProximityPipeline({ rssiSequence });

    assert.equal(results.length, 3);

    // -40 dBm -> immediate <1m
    assert.ok(results[0].distance < 1.0, `Expected distance < 1m for -40 dBm, got ${results[0].distance}`);
    assert.equal(results[0].zone, 'immediate');
    assert.equal(results[0].label, '<1m');

    // -65 dBm -> near 1-5m
    assert.ok(
      results[1].distance >= 1.0 && results[1].distance <= 5.0,
      `Expected distance 1-5m for -65 dBm, got ${results[1].distance}`
    );
    assert.equal(results[1].zone, 'near');
    assert.equal(results[1].label, '1-5m');

    // -90 dBm -> far >5m
    assert.ok(results[2].distance > 5.0, `Expected distance > 5m for -90 dBm, got ${results[2].distance}`);
    assert.equal(results[2].zone, 'far');
    assert.equal(results[2].label, '>5m');

    assert.deepEqual(zoneSequence, ['immediate', 'near', 'far']);
  });

  it('Test 3.3: Network Disconnection & P2P indicator update when GATT link drops', () => {
    const initialPeers = ['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02'];

    // Initial state check
    assert.equal(updateP2pStatus(initialPeers), 'CONNECTED');

    // Drop first device
    const resDrop1 = simulateNetworkDisconnection({ initialPeers, droppedMac: 'AA:BB:CC:DD:EE:01' });
    assert.equal(resDrop1.initialStatus, 'CONNECTED');
    assert.deepEqual(resDrop1.remainingPeers, ['AA:BB:CC:DD:EE:02']);
    assert.equal(resDrop1.finalStatus, 'CONNECTED', 'Should remain CONNECTED while 1 peer is connected');

    // Drop second device -> 0 peers
    const resDrop2 = simulateNetworkDisconnection({
      initialPeers: resDrop1.remainingPeers,
      droppedMac: 'AA:BB:CC:DD:EE:02',
    });
    assert.equal(resDrop2.initialStatus, 'CONNECTED');
    assert.deepEqual(resDrop2.remainingPeers, []);
    assert.equal(resDrop2.finalStatus, 'DISCONNECTED', 'Should update to DISCONNECTED when last peer drops');
  });

  it('Test 3.4: Manual Add-by-ID within BLE range triggers auto-connect and presence key exchange', () => {
    const inRangePeers = [
      {
        id: 'VX-TARGET-01',
        name: 'Target Peer',
        mac: 'FF:EE:DD:CC:BB:AA',
        pubkey: Buffer.alloc(32, 99).toString('base64'),
      },
    ];

    // Case 1: Manual ID matches peer in BLE range
    const resMatch = simulateManualAddById({ manualId: 'VX-TARGET-01', inRangePeers });
    assert.equal(resMatch.valid, true);
    assert.equal(resMatch.foundInRange, true);
    assert.equal(resMatch.autoConnect, true);
    assert.equal(resMatch.presenceExchanged, true);
    assert.ok(resMatch.presenceEnvelope);
    assert.equal(resMatch.presenceEnvelope.senderId, 'VX-TARGET-01');

    // Case 2: Manual ID not in BLE range
    const resOutOfRange = simulateManualAddById({ manualId: 'VX-OUT-OF-RANGE', inRangePeers });
    assert.equal(resOutOfRange.valid, true);
    assert.equal(resOutOfRange.foundInRange, false);
    assert.equal(resOutOfRange.autoConnect, false);
    assert.equal(resOutOfRange.presenceExchanged, false);
  });

  it('Test 3.5: Multi-hop mesh relay forwarding with LRU duplicate drop', () => {
    const sender = { id: 'VX-SENDER' };
    const relay = { id: 'VX-RELAY', lruCache: [] };
    const recipient = { id: 'VX-RECIPIENT', lruCache: [], receivedMessages: [] };

    const message = {
      msgId: 'msg-mesh-001',
      ttl: 32,
      senderId: 'VX-SENDER',
      recipientId: 'VX-RECIPIENT',
      ciphertext: 'enc-payload-bytes',
    };

    // First relay pass: forwarded cleanly to recipient
    const res1 = simulateMeshRelay({ sender, relay, recipient, message });
    assert.equal(res1.relayed, true);
    assert.equal(res1.duplicateDropped, false);
    assert.equal(res1.recipientReceived, true);
    assert.equal(res1.ttlRemaining, 31);
    assert.equal(recipient.receivedMessages.length, 1);

    // Second relay pass with same msgId (duplicate arrival at relay): dropped by relay LRU cache
    const resDuplicate = simulateMeshRelay({ sender, relay, recipient, message });
    assert.equal(resDuplicate.relayed, false);
    assert.equal(resDuplicate.duplicateDropped, true);
    assert.equal(resDuplicate.recipientReceived, false);
    assert.equal(recipient.receivedMessages.length, 1, 'Duplicate message should not be received twice');
  });
});
