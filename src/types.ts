// R9 Core Domain Interfaces
export interface Peer {
  id: string;
  name: string;
  online: boolean;
  lastSeen?: Date | string;
  rssi?: number;
  address?: string;
  lat?: number;
  lon?: number;
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
  chatId?: string;
  text: string;
  sent?: boolean;
  timestamp: Date | string;
  delivered?: boolean;
}

// IPC Event Payload Types
export interface MessageReceivedPayload {
  id: string;
  peerId: string;
  text: string;
  timestamp: string;
}

export interface PeerDiscoveredPayload {
  id: string;
  name: string;
  online: boolean;
  rssi?: number;
  address?: string;
}

export interface PeerStatusPayload {
  id: string;
  online: boolean;
}

export interface MessageAckPayload {
  msgId: string;
  peerId: string;
}

export interface PeerLocationPayload {
  peerId: string;
  lat: number;
  lon: number;
  timestamp: string;
}

// Legacy & UI Component Types & Aliases
export type TabType = 'chats' | 'contacts' | 'menu';
export type Tab = TabType;

export interface ProfileSettings {
  nickname: string;
  avatar: string;
  bio: string;
  nodeId: string;
}

export interface TransportSettings {
  udp: boolean;
  ble: boolean;
  internet: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  volume: number;
}

export interface Contact {
  nodeId: string;
  nickname: string;
  avatar: string;
  avatarColor: string;
  bio: string;
  isOnline: boolean;
  lastSeen?: string;
}

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

export type ThemePreference = 'system' | 'light' | 'dark';

export type PowerMode = 'FullMesh' | 'LowPowerRelay' | 'ReceiverOnly' | 'Stealth';

export interface MeshSettings {
  visibility: 'Public' | 'Stealth';
  powerMode: PowerMode;
  ephemeralId?: string;
  keysGeneratedAt?: string;
}
