import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  Peer,
  MessageReceivedPayload,
  PeerDiscoveredPayload,
  PeerStatusPayload,
  MessageAckPayload,
  PeerLocationPayload,
} from './types';

export type { UnlistenFn };

export const startMesh = async (): Promise<void> => {
  try {
    await invoke('start_mesh');
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
  }
};

export const addPeer = async (peerId: string, name: string): Promise<void> => {
  try {
    await invoke('add_peer', { peerId, name });
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
  }
};

export const triggerPanic = async (): Promise<void> => {
  try {
    await invoke('trigger_panic_button');
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
  }
};

export const checkForUpdates = async (): Promise<string | null> => {
  try {
    return await invoke<string>('check_for_updates');
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return null;
  }
};

export const installUpdate = async (version: string): Promise<void> => {
  try {
    await invoke('install_update', { version });
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
  }
};

export const sendMessage = async (peerId: string, text: string): Promise<void> => {
  try {
    await invoke('send_message', { peerId, text });
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
  }
};

export const getPeers = async (): Promise<Peer[]> => {
  try {
    return await invoke<Peer[]>('get_peers');
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return [];
  }
};

export const getNodeId = async (): Promise<string> => {
  try {
    return await invoke<string>('get_node_id');
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return '';
  }
};

export const onMessageReceived = async (
  callback: (payload: MessageReceivedPayload) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<MessageReceivedPayload>('message_received', (event) => {
      callback(event.payload);
    });
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return undefined;
  }
};

export const onPeerDiscovered = async (
  callback: (payload: PeerDiscoveredPayload) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<PeerDiscoveredPayload>('peer_discovered', (event) => {
      callback(event.payload);
    });
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return undefined;
  }
};

export const onPeerStatus = async (
  callback: (payload: PeerStatusPayload) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<PeerStatusPayload>('peer_status', (event) => {
      callback(event.payload);
    });
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return undefined;
  }
};

export const onMessageAckReceived = async (
  callback: (payload: MessageAckPayload) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<MessageAckPayload>('message_ack_received', (event) => {
      callback(event.payload);
    });
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return undefined;
  }
};

export const onPeerLocationReceived = async (
  callback: (payload: PeerLocationPayload) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<PeerLocationPayload>('peer_location_received', (event) => {
      callback(event.payload);
    });
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return undefined;
  }
};

// ---- Prawdziwe BLE (natywny most JNI, tylko Android) ----

export const bleInit = async (name: string): Promise<void> => {
  try {
    await invoke('ble_init', { name });
  } catch (error) {
    console.warn('BLE init failed / niedostepne:', error);
  }
};

export const bleStartAdvertising = async (): Promise<boolean> => {
  try {
    return await invoke<boolean>('ble_start_advertising');
  } catch (error) {
    console.warn('BLE advertise failed / niedostepne:', error);
    return false;
  }
};

export const bleStartScanning = async (): Promise<boolean> => {
  try {
    return await invoke<boolean>('ble_start_scanning');
  } catch (error) {
    console.warn('BLE scan failed / niedostepne:', error);
    return false;
  }
};

export const bleStopScanning = async (): Promise<void> => {
  try {
    await invoke('ble_stop_scanning');
  } catch (error) {
    console.warn('BLE stop scan failed:', error);
  }
};

export const bleSendMessage = async (address: string, text: string): Promise<boolean> => {
  try {
    return await invoke<boolean>('ble_send_message', { address, text });
  } catch (error) {
    console.warn('BLE send failed:', error);
    return false;
  }
};

// ---- Mesh: multi-hop routing + E2EE (nad warstwa BLE powyzej) ----

export const meshGetPublicKey = async (): Promise<string | undefined> => {
  try {
    return await invoke<string>('mesh_get_public_key');
  } catch (error) {
    console.warn('mesh_get_public_key failed:', error);
    return undefined;
  }
};

export const meshSendText = async (recipientId: string, text: string): Promise<string> => {
  try {
    return await invoke<string>('mesh_send_text', { recipientId, text });
  } catch (error) {
    console.warn('mesh_send_text failed (peer moze byc nieznany/poza zasiegiem):', error);
    throw error;
  }
};

export const meshSendLocation = async (recipientId: string, lat: number, lon: number): Promise<string> => {
  try {
    return await invoke<string>('mesh_send_location', { recipientId, lat, lon });
  } catch (error) {
    console.warn('mesh_send_location failed:', error);
    throw error;
  }
};

export interface BlePeerDiscovered {
  address: string;
  shortId: string;
  name: string;
  rssi: number;
}

export const onBlePeerDiscovered = async (
  callback: (payload: BlePeerDiscovered) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<BlePeerDiscovered>('ble_peer_discovered', (event) => callback(event.payload));
  } catch (error) {
    return undefined;
  }
};

export const onBleMessageReceived = async (
  callback: (payload: { address: string; text: string }) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<{ address: string; text: string }>('ble_message_received', (event) =>
      callback(event.payload)
    );
  } catch (error) {
    return undefined;
  }
};

export const onNfcTagRead = async (
  callback: (payload: { payload: string }) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<{ payload: string }>('nfc_tag_read', (event) => callback(event.payload));
  } catch (error) {
    return undefined;
  }
};

export const getConnectedAddresses = async (): Promise<string[]> => {
  try {
    return await invoke<string[]>('get_connected_addresses');
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return [];
  }
};

export const onBlePeerConnected = async (
  callback: (payload: { address: string }) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<{ address: string }>('ble_peer_connected', (event) => callback(event.payload));
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return undefined;
  }
};

export const onBlePeerDisconnected = async (
  callback: (payload: { address: string }) => void
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<{ address: string }>('ble_peer_disconnected', (event) => callback(event.payload));
  } catch (error) {
    console.warn('Tauri IPC not available in dev mode:', error);
    return undefined;
  }
};
