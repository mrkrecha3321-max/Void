import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRssiDistance,
  handleCorruptedPresence,
  defensiveBleManagerCheck,
  defensiveNfcCheck,
  deduplicateMessage,
  validatePeerId,
  checkMainActivityInstance,
  handlePeerDisconnect,
  updateP2pStatus,
  sendTextContract,
} from './helpers/mesh_contracts.mjs';

describe('Tier 2: Boundary & Corner Cases Verification', () => {
  it('Test 2.1: Invalid/extreme RSSI values (0 dBm, positive RSSI, NaN, null, -120 dBm) return safe fallback distances without crashing', () => {
    const distZero = calculateRssiDistance(0);
    assert.equal(typeof distZero, 'number');
    assert.equal(distZero, 5.0, '0 dBm should return safe fallback distance 5.0m');

    const distPos = calculateRssiDistance(10);
    assert.equal(typeof distPos, 'number');
    assert.equal(distPos, 5.0, 'Positive RSSI should return safe fallback distance 5.0m');

    const distNan = calculateRssiDistance(NaN);
    assert.equal(typeof distNan, 'number');
    assert.equal(distNan, 5.0, 'NaN RSSI should return safe fallback distance 5.0m');

    const distNull = calculateRssiDistance(null);
    assert.equal(typeof distNull, 'number');
    assert.equal(distNull, 5.0, 'Null RSSI should return safe fallback distance 5.0m');

    const distUndef = calculateRssiDistance(undefined);
    assert.equal(typeof distUndef, 'number');
    assert.equal(distUndef, 5.0, 'Undefined RSSI should return safe fallback distance 5.0m');

    const distExtreme = calculateRssiDistance(-120);
    assert.equal(typeof distExtreme, 'number');
    assert.equal(distExtreme, 100.0, '-120 dBm RSSI should return clamped fallback max distance 100.0m');
  });

  it('Test 2.2: Malformed Peer ID inputs (empty string, null, invalid characters) return validation error', () => {
    const resEmpty = validatePeerId('');
    assert.equal(resEmpty.valid, false);
    assert.ok(resEmpty.error.includes('empty'));

    const resSpaces = validatePeerId('   ');
    assert.equal(resSpaces.valid, false);
    assert.ok(resSpaces.error.includes('empty'));

    const resNull = validatePeerId(null);
    assert.equal(resNull.valid, false);
    assert.ok(resNull.error.includes('string'));

    const resInvalidChars = validatePeerId('VX-<script>alert(1)</script>');
    assert.equal(resInvalidChars.valid, false);
    assert.ok(resInvalidChars.error.includes('invalid characters'));

    const resValid = validatePeerId('VX-A1B2C3D4');
    assert.equal(resValid.valid, true);
    assert.equal(resValid.peerId, 'VX-A1B2C3D4');
  });

  it('Test 2.3: Malformed presence packet JSON (missing msgType, invalid Base64 senderPubkey, syntax error) is safely rejected', () => {
    const validPubkey = Buffer.alloc(32, 1).toString('base64');

    const missingTypeObj = {
      senderId: 'VX-TEST1',
      senderPubkey: validPubkey,
      recipientId: '*',
    };
    const resMissingType = handleCorruptedPresence(missingTypeObj);
    assert.equal(resMissingType.success, false);
    assert.equal(resMissingType.dropped, true);

    const badKeyObj = {
      msgType: 'presence',
      senderId: 'VX-TEST1',
      senderPubkey: 'not-a-valid-32-byte-base64-key!!!',
      recipientId: '*',
    };
    const resBadKey = handleCorruptedPresence(badKeyObj);
    assert.equal(resBadKey.success, false);
    assert.equal(resBadKey.dropped, true);

    const malformedJsonStr = '{"msgType": "presence", "senderId": "VX-1", "senderPubkey": ';
    const resSyntaxErr = handleCorruptedPresence(malformedJsonStr);
    assert.equal(resSyntaxErr.success, false);
    assert.equal(resSyntaxErr.dropped, true);
    assert.ok(resSyntaxErr.error.includes('Syntax error'));
  });

  it('Test 2.4: Attempting send_text with unknown recipient ID returns "Nieznany klucz publiczny odbiorcy" error without throwing', () => {
    const state = {
      knownPubkeys: new Map(),
    };

    const unknownRecipientId = 'VX-UNKNOWN-999';
    let result;

    assert.doesNotThrow(() => {
      result = sendTextContract(state, unknownRecipientId, 'Test message content');
    });

    assert.equal(result.success, false);
    assert.ok(
      result.error.includes('Nieznany klucz publiczny odbiorcy'),
      `Error message should contain expected text. Got: ${result.error}`
    );
  });

  it('Test 2.5: Runtime permission denial (hasPermission: false) returns false safely without uncaught exception', () => {
    let result;

    assert.doesNotThrow(() => {
      result = defensiveBleManagerCheck({
        adapterEnabled: true,
        hasPermission: false,
        bluetoothLeAdvertiser: {},
      });
    });

    assert.equal(result, false, 'Permission denial must safely return false');
  });

  it('Test 2.6: Bluetooth adapter disabled (adapterEnabled: false or adapter == null) handles calls defensively without NPE', () => {
    let resDisabled, resNullAdapter, resNullParams;

    assert.doesNotThrow(() => {
      resDisabled = defensiveBleManagerCheck({
        adapterEnabled: false,
        hasPermission: true,
        bluetoothLeAdvertiser: {},
      });

      resNullAdapter = defensiveBleManagerCheck({
        adapterEnabled: true,
        hasPermission: true,
        bluetoothLeAdvertiser: null,
      });

      resNullParams = defensiveBleManagerCheck(null);
    });

    assert.equal(resDisabled, false, 'Disabled BLE adapter must return false without NPE');
    assert.equal(resNullAdapter, false, 'Null BluetoothLeAdvertiser must return false without NPE');
    assert.equal(resNullParams, false, 'Null params must return false without NPE');
  });

  it('Test 2.7: NFC enableForegroundDispatch catches IllegalStateException and returns nfc_error event payload', () => {
    let result;

    assert.doesNotThrow(() => {
      result = defensiveNfcCheck({
        nfcAdapter: { enabled: true },
        activityState: 'resumed_with_exception',
        throwsIllegalState: true,
      });
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'nfc_error');
    assert.ok(
      result.details.includes('IllegalStateException'),
      `Details should report IllegalStateException. Got: ${result.details}`
    );
  });

  it('Test 2.8: Nullable MainActivity instance check (instance == null) returns early without throwing NullPointerException', () => {
    let resultNull, resultUndef;

    assert.doesNotThrow(() => {
      resultNull = checkMainActivityInstance(null);
      resultUndef = checkMainActivityInstance(undefined);
    });

    assert.equal(resultNull.ready, false);
    assert.equal(resultNull.status, 'early_return_null_instance');
    assert.equal(resultUndef.ready, false);
    assert.equal(resultUndef.status, 'early_return_null_instance');
  });

  it('Test 2.9: LRU deduplication cache drops duplicate message IDs and caps history length', () => {
    const lruCache = [];
    const maxCapacity = 3;

    const res1 = deduplicateMessage('msg-100', lruCache, maxCapacity);
    assert.equal(res1.isDuplicate, false);
    assert.equal(res1.action, 'process');
    assert.deepEqual(lruCache, ['msg-100']);

    const resDuplicate = deduplicateMessage('msg-100', lruCache, maxCapacity);
    assert.equal(resDuplicate.isDuplicate, true);
    assert.equal(resDuplicate.action, 'drop');
    assert.equal(lruCache.length, 1);

    deduplicateMessage('msg-101', lruCache, maxCapacity);
    deduplicateMessage('msg-102', lruCache, maxCapacity);
    assert.equal(lruCache.length, 3);
    assert.deepEqual(lruCache, ['msg-100', 'msg-101', 'msg-102']);

    const res4 = deduplicateMessage('msg-103', lruCache, maxCapacity);
    assert.equal(res4.isDuplicate, false);
    assert.equal(lruCache.length, 3);
    assert.deepEqual(lruCache, ['msg-101', 'msg-102', 'msg-103']);

    const resEvicted = deduplicateMessage('msg-100', lruCache, maxCapacity);
    assert.equal(resEvicted.isDuplicate, false);
    assert.deepEqual(lruCache, ['msg-102', 'msg-103', 'msg-100']);
  });

  it('Test 2.10: Disconnected state transition removes dropped MAC address from connected_addresses state', () => {
    let connectedAddresses = ['AA:BB:CC:DD:EE:FF', '11:22:33:44:55:66'];
    assert.equal(updateP2pStatus(connectedAddresses), 'CONNECTED');

    connectedAddresses = handlePeerDisconnect(connectedAddresses, 'AA:BB:CC:DD:EE:FF');
    assert.deepEqual(connectedAddresses, ['11:22:33:44:55:66']);
    assert.equal(
      updateP2pStatus(connectedAddresses),
      'CONNECTED',
      'One remaining device should keep P2P state as CONNECTED'
    );

    connectedAddresses = handlePeerDisconnect(connectedAddresses, '11:22:33:44:55:66');
    assert.deepEqual(connectedAddresses, []);
    assert.equal(
      updateP2pStatus(connectedAddresses),
      'DISCONNECTED',
      'No remaining devices should transition P2P state to DISCONNECTED'
    );
  });
});
