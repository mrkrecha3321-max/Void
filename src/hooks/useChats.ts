import { useState, useCallback, useEffect, useRef } from 'react';
import {
  confirmInbox,
  listPendingInbox,
  loadChatState,
  meshCreateGroup,
  meshListGroups,
  meshRetryMessage,
  meshSendChannelMessage,
  meshSendGroupMessage,
  meshSendText,
  onGroupInvited,
  onMessageAckReceived,
  onMessageReceived,
  onMessageTransportFailed,
  onMessageTransportSent,
  onPeerDiscovered,
  saveChatState,
} from '../api';
import type { Chat, Message, MessageReceivedPayload, PeerDiscoveredPayload, MessageAckPayload, InboxMessagePayload, GroupInfo } from '../types';
import { peerIdsMatch, preferFullPeerId } from '../peerLink';
import { playPttClick, playRogerBeep } from '../utils/tacticalAudio';

const DEFAULT_CHANNELS: Array<{ peerId: string; peerName: string }> = [
  { peerId: '#ogolny', peerName: '#ogolny — Kanał Ogólny' },
  { peerId: '#pomoc', peerName: '#pomoc — Wsparcie w Terenie' },
  { peerId: '#ratownictwo', peerName: '#ratownictwo — Sztab Ratunkowy' },
];

const ensureDefaultChannelsAndGroups = (existingChats: Chat[], groups: GroupInfo[]): Chat[] => {
  const result = [...existingChats];
  for (const ch of DEFAULT_CHANNELS) {
    const idx = result.findIndex(c => c.peerId.toLowerCase() === ch.peerId.toLowerCase());
    if (idx === -1) {
      result.push({
        id: `channel-${ch.peerId.slice(1)}`,
        peerId: ch.peerId,
        peerName: ch.peerName,
        unreadCount: 0,
        kind: 'channel',
      });
    } else if (!result[idx].kind) {
      result[idx] = { ...result[idx], kind: 'channel' };
    }
  }
  for (const grp of groups) {
    const idx = result.findIndex(c => c.peerId === grp.groupId);
    if (idx === -1) {
      result.unshift({
        id: `group-${grp.groupId}`,
        peerId: grp.groupId,
        peerName: grp.name,
        unreadCount: 0,
        kind: 'group',
        members: grp.members,
      });
    } else {
      result[idx] = {
        ...result[idx],
        peerName: grp.name || result[idx].peerName,
        kind: 'group',
        members: grp.members,
      };
    }
  }
  return result;
};

const localId = (prefix: string): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const pruneExpiredMessages = (messages: Record<string, Message[]>): Record<string, Message[]> => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return Object.fromEntries(
    Object.entries(messages).map(([chatId, chatMessages]) => [
      chatId,
      chatMessages.filter(message => {
        const timestamp = new Date(message.timestamp).getTime();
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      }),
    ]),
  );
};

export function useChats() {
  const [chats, setChats] = useState<Chat[]>(() => ensureDefaultChannelsAndGroups([], []));
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [hydrated, setHydrated] = useState(false);

  const chatsRef = useRef<Chat[]>(chats);
  const hydratedRef = useRef(false);
  const acceptedIncomingIdsRef = useRef<Set<string>>(new Set());
  const deliveryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  const findChat = useCallback((peerId: string): Chat | undefined => {
    return chatsRef.current.find(chat =>
      peerIdsMatch(chat.peerId, peerId) || peerIdsMatch(chat.id, peerId)
    );
  }, []);

  const ingestIncoming = useCallback((payload: InboxMessagePayload | MessageReceivedPayload, isLiveEvent = false) => {
    // Until encrypted history is loaded, the durable Rust inbox remains the
    // source of truth. Ingesting a live event earlier could be overwritten by
    // hydration and then skipped as a duplicate during the inbox drain.
    if (!hydratedRef.current) return;
    const incomingId = String(payload.id || localId('received-message'));
    if (acceptedIncomingIdsRef.current.has(incomingId)) return;
    acceptedIncomingIdsRef.current.add(incomingId);
    if (isLiveEvent) {
      playRogerBeep();
    }

    const msgDate = new Date(payload.timestamp);
    const timestamp = isNaN(msgDate.getTime()) ? new Date() : msgDate;
    const isChannel = payload.peerId.startsWith('#');
    const isGroup = payload.peerId.startsWith('GRP-');
    const resolvedKind: 'direct' | 'channel' | 'group' = isChannel ? 'channel' : isGroup ? 'group' : 'direct';

    let existing = findChat(payload.peerId);
    if (!existing) {
      existing = {
        id: isChannel ? `channel-${payload.peerId.slice(1)}` : isGroup ? `group-${payload.peerId}` : localId('chat'),
        peerId: payload.peerId,
        peerName: payload.peerId,
        unreadCount: 0,
        kind: resolvedKind,
      };
      // Update synchronously so a burst drained from the durable inbox cannot
      // create multiple chats for the same peer before React flushes state.
      chatsRef.current = [existing, ...chatsRef.current];
    }
    const chatId = existing.id;

    const incomingMsg: Message = {
      id: incomingId,
      clientKey: incomingId,
      chatId,
      text: payload.text,
      sent: false,
      timestamp,
      senderId: payload.senderId || (!isChannel && !isGroup ? payload.peerId : undefined),
      senderName: payload.senderName,
    };

    setMessages(prev => {
      if (Object.values(prev).some(chatMessages =>
        chatMessages.some(message => message.id === incomingMsg.id || message.clientKey === incomingMsg.clientKey)
      )) {
        return prev;
      }
      return {
        ...prev,
        [chatId]: [...(prev[chatId] || []), incomingMsg],
      };
    });

    setChats(prev => {
      const index = prev.findIndex(c =>
        c.id === chatId || peerIdsMatch(c.peerId, payload.peerId) || peerIdsMatch(c.id, payload.peerId)
      );
      if (index >= 0) {
        const updated = prev.map((c, i) =>
          i === index
            ? {
                ...c,
                peerId: preferFullPeerId(c.peerId, payload.peerId),
                lastMessage: payload.text,
                lastMessageTime: timestamp,
                unreadCount: c.unreadCount + 1,
                kind: c.kind || resolvedKind,
              }
            : c
        );
        chatsRef.current = updated;
        return updated;
      }
      const newChat: Chat = {
        id: chatId,
        peerId: payload.peerId,
        peerName: payload.peerId,
        lastMessage: payload.text,
        lastMessageTime: timestamp,
        unreadCount: 1,
        kind: resolvedKind,
      };
      const updated = [newChat, ...prev];
      chatsRef.current = updated;
      return updated;
    });
  }, [findChat]);

  const drainInboxIntoState = useCallback(async (active = true) => {
    if (!(window as any)['__TAURI_INTERNALS__']) return;
    try {
      const pending = await listPendingInbox();
      if (!active || !Array.isArray(pending)) return;
      pending.forEach(item => ingestIncoming(item, false));
    } catch (error) {
      console.warn('Nie udało się odczytać trwałego inbox:', error);
    }
  }, [ingestIncoming]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      if (!(window as any)['__TAURI_INTERNALS__']) {
        hydratedRef.current = true;
        setHydrated(true);
        return;
      }
      try {
        const [stored, groups] = await Promise.all([
          loadChatState(),
          meshListGroups().catch(() => [] as GroupInfo[]),
        ]);
        if (!active) return;
        const rawChats = Array.isArray(stored.chats)
          ? (stored.chats as Chat[]).filter(chat =>
              chat && typeof chat.id === 'string' && typeof chat.peerId === 'string'
            ).slice(0, 500)
          : [];
        const restoredChats = ensureDefaultChannelsAndGroups(rawChats, groups);
        const restoredMessages: Record<string, Message[]> = {};
        if (stored.messages && typeof stored.messages === 'object') {
          for (const [chatId, candidate] of Object.entries(stored.messages)) {
            if (!Array.isArray(candidate)) continue;
            restoredMessages[chatId] = (candidate as Message[])
              .filter(message => {
                if (!message || (typeof message.id !== 'string' && typeof message.id !== 'number') || typeof message.text !== 'string') {
                  return false;
                }
                const maxLen = message.text.startsWith('VOID_MEDIA:') ? 24576 : 2048;
                return message.text.length <= maxLen;
              })
              .slice(-500);
          }
        }
        let finalMessages = restoredMessages;
        try {
          const preferences = JSON.parse(localStorage.getItem('vortex-settings') || '{}') as {
            autoDestruct?: boolean;
          };
          if (preferences.autoDestruct) finalMessages = pruneExpiredMessages(restoredMessages);
        } catch {
        }
        setChats(restoredChats);
        setMessages(finalMessages);
        chatsRef.current = restoredChats;
        acceptedIncomingIdsRef.current = new Set(
          Object.values(finalMessages)
            .flat()
            .filter(message => !message.sent)
            .map(message => String(message.id)),
        );
        hydratedRef.current = true;
        setHydrated(true);
        await drainInboxIntoState(active);
      } catch (error) {
        console.error('Nie udało się odczytać zaszyfrowanej historii:', error);
        if (active) {
          hydratedRef.current = true;
          setHydrated(true);
          await drainInboxIntoState(true);
        }
      } finally {
        if (!active) hydratedRef.current = false;
      }
    };
    void restore();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void drainInboxIntoState(true);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      active = false;
      hydratedRef.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [drainInboxIntoState]);

  useEffect(() => {
    if (!hydrated || !(window as any)['__TAURI_INTERNALS__']) return;
    const timeout = setTimeout(() => {
      let persistedMessages = messages;
      try {
        const localSettings = JSON.parse(localStorage.getItem('vortex-settings') || '{}') as {
          autoDestruct?: boolean;
        };
        if (localSettings.autoDestruct) {
          persistedMessages = pruneExpiredMessages(messages);
        }
      } catch {
      }
      void saveChatState({ chats: chats.slice(0, 500), messages: persistedMessages }).then(async () => {
        const receivedIds = Object.values(persistedMessages)
          .flat()
          .filter(message => !message.sent)
          .map(message => String(message.id));
        if (receivedIds.length > 0) {
          await confirmInbox(receivedIds).catch(() => {});
        }
      }).catch(error => {
        console.error('Nie udało się zapisać zaszyfrowanej historii:', error);
      });
    }, 500);
    return () => clearTimeout(timeout);
  }, [chats, messages, hydrated]);

  useEffect(() => {
    const interval = setInterval(() => {
      try {
        const preferences = JSON.parse(localStorage.getItem('vortex-settings') || '{}') as {
          autoDestruct?: boolean;
        };
        if (preferences.autoDestruct) {
          setMessages(previous => pruneExpiredMessages(previous));
        }
      } catch {
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleSettingsChange = (event: Event) => {
      const settingsEvent = event as CustomEvent<{ autoDestruct?: boolean }>;
      if (settingsEvent.detail?.autoDestruct) {
        setMessages(previous => pruneExpiredMessages(previous));
      }
    };
    window.addEventListener('vortex-settings-changed', handleSettingsChange);
    return () => window.removeEventListener('vortex-settings-changed', handleSettingsChange);
  }, []);

  useEffect(() => {
    const unlistenPromise = onPeerDiscovered((payload: PeerDiscoveredPayload) => {
      if (!payload.id) return;
      const peerId = payload.id;
      const peerName = payload.name || peerId;

      setChats(prev => {
        const existingIndex = prev.findIndex(c =>
          peerIdsMatch(c.peerId, peerId) || peerIdsMatch(c.id, peerId)
        );
        if (existingIndex < 0) return prev;
        const existing = prev[existingIndex];
        const nextPeerId = preferFullPeerId(existing.peerId, peerId);
        const nextName = existing.peerName === existing.peerId && peerName !== existing.peerId
          ? peerName
          : existing.peerName;
        if (nextPeerId === existing.peerId && nextName === existing.peerName) return prev;
        const updated = [...prev];
        updated[existingIndex] = { ...existing, peerId: nextPeerId, peerName: nextName };
        chatsRef.current = updated;
        return updated;
      });
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten && unlisten());
    };
  }, []);

  const startChat = useCallback((peerId: string, peerName: string): string => {
    const existing = chatsRef.current.find(c =>
      peerIdsMatch(c.peerId, peerId) || peerIdsMatch(c.id, peerId)
    );
    if (existing) {
      if (preferFullPeerId(existing.peerId, peerId) !== existing.peerId) {
        const upgraded = chatsRef.current.map(chat =>
          chat.id === existing.id
            ? { ...chat, peerId: preferFullPeerId(chat.peerId, peerId), peerName: peerName || chat.peerName }
            : chat
        );
        chatsRef.current = upgraded;
        setChats(upgraded);
      }
      return existing.id;
    }

    const chatId = localId('chat');
    const newChat: Chat = {
      id: chatId,
      peerId,
      peerName: peerName || peerId,
      unreadCount: 0,
    };
    chatsRef.current = [newChat, ...chatsRef.current];
    setChats(prev => {
      if (prev.some(c => c.id === chatId || peerIdsMatch(c.peerId, peerId))) return prev;
      return [newChat, ...prev];
    });
    return chatId;
  }, []);

  const armDeliveryTimer = useCallback((msgId: string, chatId: string) => {
    const existing = deliveryTimersRef.current.get(msgId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      deliveryTimersRef.current.delete(msgId);
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(message =>
          message.id === msgId && !message.delivered && (message.transmitting || message.status === 'transmitting')
            ? { ...message, failed: true, queued: false, transmitting: false, status: 'failed', error: 'Przekroczono czas transmisji BLE (60 sekund)' }
            : message
        ),
      }));
    }, 60_000);
    deliveryTimersRef.current.set(msgId, timer);
  }, []);

  const createGroupChat = useCallback(async (name: string, members: string[]): Promise<Chat> => {
    const group = await meshCreateGroup(name, members);
    const chatId = `group-${group.groupId}`;
    const newChat: Chat = {
      id: chatId,
      peerId: group.groupId,
      peerName: group.name,
      unreadCount: 0,
      kind: 'group',
      members: group.members,
    };
    setChats(prev => {
      const existingIdx = prev.findIndex(c => c.peerId === group.groupId);
      const updated = existingIdx >= 0
        ? prev.map((c, idx) => (idx === existingIdx ? { ...c, ...newChat } : c))
        : [newChat, ...prev];
      chatsRef.current = updated;
      return updated;
    });
    return newChat;
  }, []);

  const sendMessage = useCallback(async (chatId: string, text: string) => {
    const chat = chatsRef.current.find(c => c.id === chatId);
    const recipientId = chat?.peerId || chatId;
    playPttClick();
    
    const tempId = localId('pending-message');
    const msg: Message = {
      id: tempId,
      clientKey: tempId,
      chatId,
      text,
      sent: true,
      timestamp: new Date(),
      status: 'queued',
      queued: true,
    };
    
    setMessages(prev => ({
      ...prev,
      [chatId]: [...(prev[chatId] || []), msg],
    }));
    setChats(prev =>
      prev.map(c =>
        c.id === chatId
          ? { ...c, lastMessage: text, lastMessageTime: new Date() }
          : c
      )
    );
    
    try {
      const result = recipientId.startsWith('#')
        ? await meshSendChannelMessage(recipientId, text)
        : recipientId.startsWith('GRP-')
        ? await meshSendGroupMessage(recipientId, text)
        : await meshSendText(recipientId, text);
      const status = result.status === 'transmitting' || !result.queued ? 'transmitting' : 'queued';
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(message =>
          message.id === tempId
            ? {
                ...message,
                id: result.msgId,
                queued: status === 'queued',
                transmitting: status === 'transmitting',
                failed: false,
                status,
              }
            : message
        ),
      }));
      if (status === 'transmitting') armDeliveryTimer(result.msgId, chatId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(message =>
          message.id === tempId ? { ...message, failed: true, queued: false, transmitting: false, status: 'failed', error } : message
        ),
      }));
    }
  }, [armDeliveryTimer]);

  const receiveMessage = useCallback((chatId: string, text: string, _peerName: string) => {
    setChats(prev => {
      const exists = prev.find(c => c.id === chatId);
      if (!exists) return prev;
      return prev.map(c =>
        c.id === chatId
          ? { ...c, lastMessage: text, lastMessageTime: new Date(), unreadCount: c.unreadCount + 1 }
          : c
      );
    });
    const msg: Message = {
      id: localId('received-message'),
      chatId,
      text,
      sent: false,
      timestamp: new Date(),
    };
    setMessages(prev => ({
      ...prev,
      [chatId]: [...(prev[chatId] || []), msg],
    }));
  }, []);

  const messagesForChat = useCallback((chatId: string): Message[] => {
    const chat = chats.find(candidate => candidate.id === chatId);
    const relatedIds = chats
      .filter(candidate =>
        candidate.id === chatId || (chat ? peerIdsMatch(candidate.peerId, chat.peerId) : false)
      )
      .map(candidate => candidate.id);
    const ids = relatedIds.length > 0 ? relatedIds : [chatId];
    const seen = new Set<string>();
    const merged: Message[] = [];
    for (const id of ids) {
      for (const message of messages[id] || []) {
        const key = String(message.id);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(message);
      }
    }
    return merged.sort((left, right) => {
      const a = new Date(left.timestamp).getTime();
      const b = new Date(right.timestamp).getTime();
      return (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0);
    });
  }, [chats, messages]);

  const markRead = useCallback((chatId: string) => {
    setChats(prev => {
      const updated = prev.map(chat =>
        chat.id === chatId ? { ...chat, unreadCount: 0 } : chat
      );
      chatsRef.current = updated;
      return updated;
    });
  }, []);

  useEffect(() => {
    const unlistenPromise = onMessageReceived((payload: MessageReceivedPayload) => {
      ingestIncoming(payload, true);
    });

    const unlistenGroupPromise = onGroupInvited((group: GroupInfo) => {
      playRogerBeep();
      setChats(prev => {
        const updated = ensureDefaultChannelsAndGroups(prev, [group]);
        chatsRef.current = updated;
        return updated;
      });
    });

    const unlistenAckPromise = onMessageAckReceived((payload: MessageAckPayload) => {
      const timer = deliveryTimersRef.current.get(payload.msgId);
      if (timer) {
        clearTimeout(timer);
        deliveryTimersRef.current.delete(payload.msgId);
      }
      setMessages(prev => {
        const next = { ...prev };
        let modified = false;
        
        for (const [cId, msgs] of Object.entries(next)) {
          const chat = chatsRef.current.find(candidate => candidate.id === cId);
          if (!chat || !peerIdsMatch(chat.peerId, payload.peerId)) continue;
          const updatedMsgs = msgs.map(m => {
            if (m.id === payload.msgId) {
              modified = true;
              return { ...m, delivered: true, queued: false, transmitting: false, failed: false, status: 'delivered' as const, error: undefined };
            }
            return m;
          });
          if (updatedMsgs !== msgs) {
            next[cId] = updatedMsgs;
          }
        }
        
        return modified ? next : prev;
      });
    });

    const transportSentPromise = onMessageTransportSent(({ msgId }) => {
      const timer = deliveryTimersRef.current.get(msgId);
      if (timer) {
        clearTimeout(timer);
        deliveryTimersRef.current.delete(msgId);
      }
      setMessages(prev => {
        const next = { ...prev };
        for (const [chatId, chatMessages] of Object.entries(next)) {
          if (!chatMessages.some(message => message.id === msgId)) continue;
          next[chatId] = chatMessages.map(message =>
            message.id === msgId
              ? { ...message, queued: false, transmitting: false, failed: false, status: message.delivered ? 'delivered' : 'transport_sent', error: undefined }
              : message
          );
          return next;
        }
        return prev;
      });
    });

    const transportFailedPromise = onMessageTransportFailed(({ msgId, reason }) => {
      setMessages(prev => Object.fromEntries(
        Object.entries(prev).map(([chatId, chatMessages]) => [
          chatId,
          chatMessages.map(message =>
            message.id === msgId
              ? { ...message, queued: false, transmitting: false, failed: true, status: 'failed', error: reason }
              : message
          ),
        ]),
      ));
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten && unlisten());
      unlistenGroupPromise.then(unlisten => unlisten && unlisten());
      unlistenAckPromise.then(unlisten => unlisten && unlisten());
      transportSentPromise.then(unlisten => unlisten && unlisten());
      transportFailedPromise.then(unlisten => unlisten && unlisten());
      deliveryTimersRef.current.forEach(clearTimeout);
      deliveryTimersRef.current.clear();
    };
  }, [armDeliveryTimer, ingestIncoming]);

  const retryMessage = useCallback(async (chatId: string, message: Message) => {
    const msgId = String(message.id);
    setMessages(prev => ({
      ...prev,
      [chatId]: (prev[chatId] || []).map(item =>
        item.id === message.id
          ? { ...item, failed: false, queued: true, transmitting: false, status: 'queued', error: undefined }
          : item
      ),
    }));
    try {
      if (msgId.startsWith('pending-')) {
        await sendMessage(chatId, message.text);
        return;
      }
      const status = await meshRetryMessage(msgId);
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(item =>
          item.id === message.id
            ? {
                ...item,
                queued: status === 'queued',
                transmitting: status === 'transmitting',
                failed: false,
                status: status === 'transmitting' ? 'transmitting' : 'queued',
              }
            : item
        ),
      }));
      if (status === 'transmitting') armDeliveryTimer(msgId, chatId);
    } catch (error) {
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(item =>
          item.id === message.id
            ? { ...item, failed: true, queued: false, status: 'failed', error: String(error) }
            : item
        ),
      }));
    }
  }, [armDeliveryTimer, sendMessage]);

  const clearAllData = useCallback(() => {
    const resetChats = ensureDefaultChannelsAndGroups([], []);
    setChats(resetChats);
    setMessages({});
    chatsRef.current = resetChats;
    acceptedIncomingIdsRef.current.clear();
  }, []);

  return { chats, messages, messagesForChat, sendMessage, receiveMessage, startChat, createGroupChat, markRead, retryMessage, clearAllData };
}

