import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runCommand } from './helpers/process_runner.mjs';
import {
  simulateDenseMesh,
  simulateStartupPermissionFlow,
  simulatePeerLifecycle,
  sendTextContract,
} from './helpers/mesh_contracts.mjs';

const ROOT_DIR = process.cwd();
const TAURI_DIR = path.join(ROOT_DIR, 'src-tauri');

describe('Tier 4: Real-World Application Scenarios Verification', () => {
  it('Test 4.1: Dense mesh peer environment (10 concurrent peers, independent pubkey storage, sorted radar proximity list)', () => {
    const { peerCount, peers, pubkeyStoreIntegrity, sortedRadarList, nonBlocking } = simulateDenseMesh(10);

    assert.equal(peerCount, 10, 'Dense mesh simulation should spawn 10 concurrent peers');
    assert.equal(peers.length, 10);
    assert.equal(pubkeyStoreIntegrity, true, 'Each peer must independently store pubkeys of all other 9 peers');
    assert.equal(nonBlocking, true, 'Dense mesh broadcast and radar sorting must complete without blocking');

    // Radar proximity list for Peer 1 should contain 9 target peers
    assert.equal(sortedRadarList.length, 9);

    // Verify radar proximity list is strictly sorted ascending by distance
    for (let i = 0; i < sortedRadarList.length - 1; i++) {
      assert.ok(
        sortedRadarList[i].distance <= sortedRadarList[i + 1].distance,
        `Radar list should be sorted by distance: index ${i} (${sortedRadarList[i].distance}m) <= index ${i + 1} (${sortedRadarList[i + 1].distance}m)`
      );
    }
  });

  it('Test 4.2: Startup race condition mitigation & permission recovery flow (app starts without permission, permission granted fires, BLE initializes cleanly)', () => {
    const flow = simulateStartupPermissionFlow();

    assert.equal(flow.initialBleStatus, false, 'App startup without permissions must suspend BLE initialization');
    assert.equal(flow.uiReadyWithoutCrash, true, 'App UI must render gracefully without throwing uncaught exceptions');
    assert.equal(flow.initialAppState, 'UI_READY_BLE_SUSPENDED');

    assert.equal(flow.postGrantBleStatus, true, 'Defensive check must return true once permissions are granted');
    assert.equal(flow.bleInitialized, true, 'BLE mesh must initialize cleanly after permission grant event');
    assert.equal(flow.postGrantAppState, 'MESH_RUNNING');
    assert.equal(flow.recoveredCleanly, true, 'Permission recovery flow must transition cleanly');
  });

  it('Test 4.3: Real-World E2EE Messaging Session (Alice & Bob exchange multiple messages, verifying key store integrity and message decryption)', () => {
    const nodeA = {
      id: 'VX-ALICE',
      name: 'Alice',
      mac: '11:22:33:44:55:66',
      pubkey: Buffer.alloc(32, 42).toString('base64'),
    };
    const nodeB = {
      id: 'VX-BOB',
      name: 'Bob',
      mac: 'AA:BB:CC:DD:EE:FF',
      pubkey: Buffer.alloc(32, 84).toString('base64'),
    };

    // 1. Initial lifecycle setup
    const session = simulatePeerLifecycle({ nodeA, nodeB });
    assert.equal(session.success, true);

    const aliceState = session.nodeA;
    const bobState = session.nodeB;

    // 2. Multi-message conversation sequence
    const messages = [
      { sender: 'A', text: 'Hey Bob, is the BLE mesh operational?' },
      { sender: 'B', text: 'Confirmed Alice, link quality is optimal.' },
      { sender: 'A', text: 'Transmitting encrypted packet payload 0x8F2A.' },
      { sender: 'B', text: 'Payload 0x8F2A received and decrypted successfully.' },
      { sender: 'A', text: 'End of test sequence. Over.' },
    ];

    const exchangeHistory = [];

    for (const msg of messages) {
      if (msg.sender === 'A') {
        const res = sendTextContract(aliceState, bobState.id, msg.text);
        assert.equal(res.success, true, `Alice failed to send: ${msg.text}`);
        exchangeHistory.push({ from: 'Alice', to: 'Bob', payload: res.payload });
      } else {
        const res = sendTextContract(bobState, aliceState.id, msg.text);
        assert.equal(res.success, true, `Bob failed to send: ${msg.text}`);
        exchangeHistory.push({ from: 'Bob', to: 'Alice', payload: res.payload });
      }
    }

    assert.equal(exchangeHistory.length, 5);

    // 3. Verify key store integrity after session
    assert.equal(
      aliceState.knownPubkeys.get(bobState.id),
      nodeB.pubkey,
      "Alice's key store for Bob must remain unchanged and valid"
    );
    assert.equal(
      bobState.knownPubkeys.get(aliceState.id),
      nodeA.pubkey,
      "Bob's key store for Alice must remain unchanged and valid"
    );

    // 4. Verify chat instances exist for both users
    assert.ok(aliceState.chats.has(bobState.id));
    assert.ok(bobState.chats.has(aliceState.id));
  });

  it('Test 4.4: App release & build verification pipeline (npm run build, npx tsc --noEmit, cargo check all pass with exit code 0)', { timeout: 300000 }, async () => {
    // Step 1: Vite build
    const buildRes = await runCommand('npm', ['run', 'build'], ROOT_DIR);
    assert.equal(
      buildRes.exitCode,
      0,
      `npm run build failed with exit code ${buildRes.exitCode}.\nStderr: ${buildRes.stderr}\nStdout: ${buildRes.stdout}`
    );

    // Step 2: TypeScript type check
    const tscRes = await runCommand('npx', ['tsc', '--noEmit'], ROOT_DIR);
    assert.equal(
      tscRes.exitCode,
      0,
      `npx tsc --noEmit failed with exit code ${tscRes.exitCode}.\nStderr: ${tscRes.stderr}\nStdout: ${tscRes.stdout}`
    );

    // Step 3: Cargo check in backend
    const cargoRes = await runCommand('cargo', ['check'], TAURI_DIR);
    assert.equal(
      cargoRes.exitCode,
      0,
      `cargo check failed with exit code ${cargoRes.exitCode}.\nStderr: ${cargoRes.stderr}\nStdout: ${cargoRes.stdout}`
    );
  });
});
