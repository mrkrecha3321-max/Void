import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  Peer,
  MessageReceivedPayload,
  PeerDiscoveredPayload,
  PeerStatusPayload,
  MessageAckPayload,
  PeerLocationPayload,
  SosReceivedPayload,
  MeshSendResult,
  CoreMeshSettings,
  InboxMessagePayload,
  PeerLinkPayload,
} from './types';

export type { UnlistenFn };

const warnDev = (operation: string, error: unknown): void => {
  console.warn(`${operation} is unavailable:`, error);
};

export const startMesh = (): Promise<string> => invoke<string>('start_mesh');
export const addPeer = (peerId: string, name: string): Promise<void> =>
  invoke('add_peer', { peerId, name });
export const setNodeName = (name: string): Promise<void> =>
  invoke('set_node_name', { name });
export const getMeshSettings = (): Promise<CoreMeshSettings> =>
  invoke('get_mesh_settings');
export const setMeshSettings = (settings: CoreMeshSettings): Promise<void> =>
  invoke('set_mesh_settings', { settings });
export const trustPeer = (peerId: string): Promise<void> =>
  invoke('trust_peer', { peerId });
export const getContactCard = (): Promise<string> => invoke('get_contact_card');
export const importContactCard = (
  card: string,
): Promise<{ nodeId: string; name: string }> => invoke('import_contact_card', { card });
export const loadChatState = (): Promise<{ chats: unknown[]; messages: Record<string, unknown[]> }> =>
  invoke('load_chat_state');
export const saveChatState = (chatState: unknown): Promise<void> =>
  invoke('save_chat_state', { chatState });
export const exportIdentityBackup = (password: string): Promise<string> =>
  invoke('export_identity_backup', { password });
export const importIdentityBackup = (backupJson: string, password: string): Promise<void> =>
  invoke('import_identity_backup', { backupJson, password });
export const triggerPanic = (): Promise<void> => invoke('trigger_panic_button');
export const checkForUpdates = async (): Promise<string | null> => {
  try {
    return await invoke<string>('check_for_updates');
  } catch (error) {
    warnDev('check_for_updates', error);
    return null;
  }
};
export const installUpdate = (version: string): Promise<void> =>
  invoke('install_update', { version });
export const getPeers = (): Promise<Peer[]> => invoke<Peer[]>('get_peers');
export const getNodeId = (): Promise<string> => invoke<string>('get_node_id');

const subscribe = async <T>(
  eventName: string,
  callback: (payload: T) => void,
): Promise<UnlistenFn | undefined> => {
  try {
    return await listen<T>(eventName, (event) => callback(event.payload));
  } catch (error) {
    warnDev(`listen:${eventName}`, error);
    return undefined;
  }
};

export const onMessageReceived = (callback: (payload: MessageReceivedPayload) => void) =>
  subscribe('message_received', callback);
export const onPeerDiscovered = (callback: (payload: PeerDiscoveredPayload) => void) =>
  subscribe('peer_discovered', callback);
export const onPeerStatus = (callback: (payload: PeerStatusPayload) => void) =>
  subscribe('peer_status', callback);
export const onMessageAckReceived = (callback: (payload: MessageAckPayload) => void) =>
  subscribe('message_ack_received', callback);
export const onPeerLocationReceived = (callback: (payload: PeerLocationPayload) => void) =>
  subscribe('peer_location_received', callback);
export const onSosReceived = (callback: (payload: SosReceivedPayload) => void) =>
  subscribe('sos_received', callback);
export const onMessageTransportSent = (callback: (payload: { msgId: string }) => void) =>
  subscribe('message_transport_sent', callback);
export const onMessageTransportFailed = (
  callback: (payload: { msgId: string; reason: string }) => void,
) => subscribe('message_transport_failed', callback);
export const onPeerLink = (callback: (payload: PeerLinkPayload) => void) =>
  subscribe('peer_link', callback);
export const onBlePeerConnecting = (callback: (payload: { address: string }) => void) =>
  subscribe('ble_peer_connecting', callback);

export const listPendingInbox = (): Promise<InboxMessagePayload[]> =>
  invoke('list_pending_inbox');
export const confirmInbox = (ids: string[]): Promise<string[]> =>
  invoke('confirm_inbox', { ids });
export const meshRetryMessage = (msgId: string): Promise<string> =>
  invoke('mesh_retry_message', { msgId });

export const bleInit = (name: string): Promise<void> => invoke('ble_init', { name });
export const bleStartAdvertising = (): Promise<boolean> => invoke('ble_start_advertising');
export const bleStartScanning = (): Promise<boolean> => invoke('ble_start_scanning');
export const bleStopScanning = (): Promise<void> => invoke('ble_stop_scanning');
export const bleSendMessage = (address: string, text: string): Promise<boolean> =>
  invoke('ble_send_message', { address, text });
export const bleConnectToPeer = (address: string): Promise<boolean> =>
  invoke('ble_connect_to_peer', { address });

export const meshGetPublicKey = (): Promise<string> => invoke('mesh_get_public_key');
export const meshSendText = (recipientId: string, text: string): Promise<MeshSendResult> =>
  invoke('mesh_send_text', { recipientId, text });
export const meshSendLocation = (
  recipientId: string,
  lat: number,
  lon: number,
): Promise<string> => invoke('mesh_send_location', { recipientId, lat, lon });
export const meshFlushOutbox = (): Promise<void> => invoke('mesh_flush_outbox');
export const meshSendSos = (
  name: string,
  description: string,
  lat?: number,
  lon?: number,
): Promise<string> => invoke('mesh_send_sos', { name, description, lat, lon });

export interface BlePeerDiscovered {
  address: string;
  shortId: string;
  name: string;
  rssi: number;
}

export const onBlePeerDiscovered = (callback: (payload: BlePeerDiscovered) => void) =>
  subscribe('ble_peer_discovered', callback);
export const onNfcTagRead = (callback: (payload: { payload: string }) => void) =>
  subscribe('nfc_tag_read', callback);
export const getConnectedAddresses = async (): Promise<string[]> => {
  try {
    return await invoke<string[]>('get_connected_addresses');
  } catch (error) {
    warnDev('get_connected_addresses', error);
    return [];
  }
};
export const onBlePeerConnected = (callback: (payload: { address: string }) => void) =>
  subscribe('ble_peer_connected', callback);
export const onBlePeerDisconnected = (callback: (payload: { address: string }) => void) =>
  subscribe('ble_peer_disconnected', callback);
export const onBleError = (callback: (payload: { message: string }) => void) =>
  subscribe('ble_error', callback);
