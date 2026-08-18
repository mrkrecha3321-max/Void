import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyBleDiscoveryToPeer,
  mapPeerIdToAddress,
  queueOutboundMessages,
} from './helpers/mesh_contracts.mjs';

describe('Tier 5: Offline delivery reliability contracts', () => {
  it('foreground service restoration cannot recursively restart itself', () => {
    const androidDir = path.join(
      process.cwd(),
      'src-tauri',
      'gen',
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'vortex',
      'mesh',
    );
    const bleManager = fs.readFileSync(path.join(androidDir, 'BleManager.kt'), 'utf8');
    const service = fs.readFileSync(path.join(androidDir, 'MeshForegroundService.kt'), 'utf8');

    const advertising = bleManager.slice(
      bleManager.indexOf('fun startAdvertising'),
      bleManager.indexOf('fun stopAdvertising'),
    );
    const scanning = bleManager.slice(
      bleManager.indexOf('fun startScanning'),
      bleManager.indexOf('fun stopScanning'),
    );
    const onStartCommand = service.slice(
      service.indexOf('override fun onStartCommand'),
      service.indexOf('override fun onDestroy'),
    );

    assert.ok(advertising.length > 0 && scanning.length > 0 && onStartCommand.length > 0);
    assert.doesNotMatch(advertising, /ensureForegroundService\s*\(/);
    assert.doesNotMatch(scanning, /ensureForegroundService\s*\(/);
    assert.doesNotMatch(onStartCommand, /restoreIfNeeded\s*\(/);
    assert.match(service, /override fun onCreate[\s\S]*restoreIfNeeded\s*\(/);
  });

  it('discovered advertisement does not mark the peer online or ready', () => {
    const peer = applyBleDiscoveryToPeer(
      { id: 'ABCDEF01', name: 'Kontakt', online: false },
      { address: 'AA:BB:CC:DD:EE:01', shortId: 'ABCDEF01', rssi: -55 },
    );
    assert.equal(peer.linkStatus, 'discovered');
    assert.equal(peer.online, false);
    assert.notEqual(peer.linkStatus, 'ready');
    assert.notEqual(peer.linkStatus, 'connected');
  });

  it('maps a full Node ID to exactly one BLE address', () => {
    const bindings = [
      { peerId: 'VX-11111111111111111111111111111111', address: 'AA:BB:CC:DD:EE:01' },
      { peerId: 'VX-22222222222222222222222222222222', address: 'AA:BB:CC:DD:EE:02' },
    ];
    assert.equal(
      mapPeerIdToAddress(bindings, 'VX-11111111111111111111111111111111'),
      'AA:BB:CC:DD:EE:01',
    );
    assert.equal(mapPeerIdToAddress(bindings, 'VX-33333333333333333333333333333333'), null);
  });

  it('rapid consecutive sends keep distinct msgIds and do not double-queue', () => {
    const queue = { items: [], inFlight: new Set() };
    const first = queueOutboundMessages(queue, [
      { msgId: 'm1', text: 'one' },
      { msgId: 'm2', text: 'two' },
      { msgId: 'm3', text: 'three' },
      { msgId: 'm4', text: 'four' },
      { msgId: 'm5', text: 'five' },
    ]);
    assert.deepEqual(first, ['m1', 'm2', 'm3', 'm4', 'm5']);
    queue.inFlight.add('m1');
    const retry = queueOutboundMessages(queue, [
      { msgId: 'm1', text: 'one' },
      { msgId: 'm6', text: 'six' },
    ]);
    assert.deepEqual(retry, ['m6']);
    assert.equal(queue.items.length, 6);
  });
});
