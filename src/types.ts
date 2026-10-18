import type { PeerLinkStatus } from './peerLink';

export type { PeerLinkStatus };
export type MessageTransportStatus =
  | 'queued'
  | 'transmitting'
  | 'transport_sent'
  | 'delivered'
  | 'failed';

export interface Peer {
  id: string;
  name: string;
  online: boolean;
  lastSeen?: Date | string;
  lastBleSeenAt?: number;
  rssi?: number;
  address?: string;
  lat?: number;
  lon?: number;
  linkStatus?: PeerLinkStatus;
}

export interface Chat {
  id: string;
  peerId: string;
  peerName: string;
  lastMessage?: string;
  lastMessageTime?: Date | string;
  unreadCount: number;
}

export interface Message {
  id: string | number;
  clientKey?: string;
  chatId?: string;
  text: string;
  sent?: boolean;
  timestamp: Date | string;
  delivered?: boolean;
  failed?: boolean;
  queued?: boolean;
  transmitting?: boolean;
  status?: MessageTransportStatus;
  error?: string;
}

export interface MessageReceivedPayload {
  id: string;
  peerId: string;
  text: string;
  timestamp: number;
}

export interface PeerDiscoveredPayload {
  id: string;
  name: string;
  online: boolean;
  rssi?: number;
  address?: string;
  linkStatus?: PeerLinkStatus;
}

export interface PeerStatusPayload {
  id: string;
  online: boolean;
  linkStatus?: PeerLinkStatus;
}

export interface PeerLinkPayload {
  id?: string;
  address?: string;
  status: PeerLinkStatus;
}

export interface InboxMessagePayload {
  id: string;
  peerId: string;
  text: string;
  timestamp: number;
}

export interface MessageAckPayload {
  msgId: string;
  peerId: string;
}

export interface PeerLocationPayload {
  peerId: string;
  lat: number;
  lon: number;
  timestamp: number;
}

export interface MeshSendResult {
  msgId: string;
  queued: boolean;
  status?: MessageTransportStatus | string;
}

export interface CoreMeshSettings {
  relayNode: boolean;
  batterySave: boolean;
  hideNode: boolean;
  rejectNewChats: boolean;
  autoDestruct: boolean;
  locationSharing: boolean;
}

export interface SosReceivedPayload {
  id: string;
  senderId: string;
  name: string;
  description: string;
  lat?: number;
  lon?: number;
  timestamp: number;
}

export type TabType = 'chats' | 'radar' | 'contacts' | 'menu';
export type Tab = TabType;

export interface ChatNode {
  id: string;
  name: string;
  avatar: string;
  avatarColor: string;
  messages: Message[];
  time: string;
  unread: number;
  bio?: string;
}
