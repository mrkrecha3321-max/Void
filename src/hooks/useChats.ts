import { useState, useCallback, useEffect, useRef } from 'react';
import {
  confirmInbox,
  listPendingInbox,
  loadChatState,
  meshRetryMessage,
  meshSendText,
  onMessageAckReceived,
  onMessageReceived,
  onMessageTransportFailed,
  onMessageTransportSent,
  onPeerDiscovered,
  saveChatState,
} from '../api';
import type { Chat, Message, MessageReceivedPayload, PeerDiscoveredPayload, MessageAckPayload, InboxMessagePayload } from '../types';

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
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [hydrated, setHydrated] = useState(false);

  const chatsRef = useRef<Chat[]>(chats);
  const deliveryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  const ingestIncoming = useCallback((payload: InboxMessagePayload | MessageReceivedPayload) => {
    const msgDate = new Date(payload.timestamp);
    const timestamp = isNaN(msgDate.getTime()) ? new Date() : msgDate;
    let chatId: string;
    const existing = chatsRef.current.find(c => c.peerId === payload.peerId || c.id === payload.peerId);
    if (existing) {
      chatId = existing.id;
    } else {
      chatId = localId('chat');
    }

    const incomingMsg: Message = {
      id: payload.id || localId('received-message'),
      chatId,
      text: payload.text,
      sent: false,
      timestamp,
    };

    setMessages(prev => {
      if (Object.values(prev).some(chatMessages =>
        chatMessages.some(message => message.id === incomingMsg.id)
      )) {
        return prev;
      }
      return {
        ...prev,
        [chatId]: [...(prev[chatId] || []), incomingMsg],
      };
    });

    setChats(prev => {
      const index = prev.findIndex(c => c.id === chatId || c.peerId === payload.peerId);
      if (index >= 0) {
        const updated = prev.map((c, i) =>
          i === index
            ? {
                ...c,
                lastMessage: payload.text,
                lastMessageTime: timestamp,
                unreadCount: c.unreadCount + 1,
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
      };
      chatsRef.current = [newChat, ...chatsRef.current];
      return [newChat, ...prev];
    });
  }, []);

  const drainInboxIntoState = useCallback(async (active = true) => {
    if (!(window as any)['__TAURI_INTERNALS__']) return;
    try {
      const pending = await listPendingInbox();
      if (!active || !Array.isArray(pending)) return;
      pending.forEach(ingestIncoming);
    } catch (error) {
      console.warn('Nie udało się odczytać trwałego inbox:', error);
    }
  }, [ingestIncoming]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      if (!(window as any)['__TAURI_INTERNALS__']) {
        setHydrated(true);
        return;
      }
      try {
        const stored = await loadChatState();
        if (!active) return;
        const restoredChats = Array.isArray(stored.chats)
          ? (stored.chats as Chat[]).filter(chat =>
              chat && typeof chat.id === 'string' && typeof chat.peerId === 'string'
            ).slice(0, 500)
          : [];
        const restoredMessages: Record<string, Message[]> = {};
        if (stored.messages && typeof stored.messages === 'object') {
          for (const [chatId, candidate] of Object.entries(stored.messages)) {
            if (!Array.isArray(candidate)) continue;
            restoredMessages[chatId] = (candidate as Message[])
              .filter(message =>
                message && (typeof message.id === 'string' || typeof message.id === 'number') &&
                typeof message.text === 'string' && message.text.length <= 2048
              )
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
          // Keep validated history when preferences are malformed.
        }
        setChats(restoredChats);
        setMessages(finalMessages);
        chatsRef.current = restoredChats;
        await drainInboxIntoState(active);
      } catch (error) {
        console.error('Nie udało się odczytać zaszyfrowanej historii:', error);
      } finally {
        if (active) setHydrated(true);
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
        // Invalid local UI preferences do not block encrypted persistence.
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
        // Ignore malformed UI preferences.
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
        const existingIndex = prev.findIndex(c => c.peerId === peerId || c.id === peerId);
        if (existingIndex < 0) return prev;
        const existing = prev[existingIndex];
        if (existing.peerName === existing.peerId && peerName !== existing.peerId) {
          const updated = [...prev];
          updated[existingIndex] = { ...existing, peerName };
          chatsRef.current = updated;
          return updated;
        }
        return prev;
      });
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten && unlisten());
    };
  }, []);

  const startChat = useCallback((peerId: string, peerName: string): string => {
    const existing = chatsRef.current.find(c => c.peerId === peerId || c.id === peerId);
    if (existing) return existing.id;

    const chatId = localId('chat');
    const newChat: Chat = {
      id: chatId,
      peerId,
      peerName: peerName || peerId,
      unreadCount: 0,
    };
    chatsRef.current = [newChat, ...chatsRef.current];
    setChats(prev => {
      if (prev.some(c => c.id === chatId || c.peerId === peerId)) return prev;
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
          message.id === msgId && !message.delivered
            ? { ...message, failed: true, queued: false, transmitting: false, status: 'failed', error: 'Brak potwierdzenia dostarczenia w ciągu 60 sekund' }
            : message
        ),
      }));
    }, 60_000);
    deliveryTimersRef.current.set(msgId, timer);
  }, []);

  const sendMessage = useCallback(async (chatId: string, text: string) => {
    const chat = chatsRef.current.find(c => c.id === chatId);
    const recipientId = chat?.peerId || chatId;
    
    // We create a temporary message with a local ID
    const tempId = localId('pending-message');
    const msg: Message = {
      id: tempId,
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
      const result = await meshSendText(recipientId, text);
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
      ingestIncoming(payload);
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
          if (!chat || chat.peerId !== payload.peerId) continue;
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
      setMessages(prev => {
        const next = { ...prev };
        for (const [chatId, chatMessages] of Object.entries(next)) {
          if (!chatMessages.some(message => message.id === msgId)) continue;
          next[chatId] = chatMessages.map(message =>
            message.id === msgId
              ? { ...message, queued: false, transmitting: false, failed: false, status: 'transport_sent', error: undefined }
              : message
          );
          armDeliveryTimer(msgId, chatId);
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
    setChats([]);
    setMessages({});
    chatsRef.current = [];
  }, []);

  return { chats, messages, sendMessage, receiveMessage, startChat, markRead, retryMessage, clearAllData };
}
