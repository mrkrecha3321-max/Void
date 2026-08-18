import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ackInbox,
  drainInbox,
  loadChatState,
  meshSendText,
  onMessageAckReceived,
  onMessageReceived,
  onMessageTransportFailed,
  onMessageTransportSent,
  onPeerDiscovered,
  saveChatState,
} from '../api';
import type { Chat, Message, MessageReceivedPayload, PeerDiscoveredPayload, MessageAckPayload } from '../types';

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

interface IncomingRecord {
  id: string;
  peerId: string;
  text: string;
  timestamp: number | Date | string;
}

export function useChats() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [hydrated, setHydrated] = useState(false);

  const chatsRef = useRef<Chat[]>(chats);
  const deliveryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  /**
   * Insert an inbound message into React state + chat list exactly once.
   * Shared by the live `message_received` event and the durable inbox drain so
   * a crash/restart between arrival and UI display cannot lose a message.
   * Returns the chatId the message belongs to (or was de-duplicated into).
   */
  const ingestIncoming = useCallback((record: IncomingRecord): string => {
    const msgDate = new Date(record.timestamp);
    const timestamp = isNaN(msgDate.getTime()) ? new Date() : msgDate;

    let chatId: string;
    const existing = chatsRef.current.find(
      c => c.peerId === record.peerId || c.id === record.peerId,
    );
    if (existing) {
      chatId = existing.id;
    } else {
      chatId = localId('chat');
    }

    const incomingMsg: Message = {
      id: record.id || localId('received-message'),
      chatId,
      text: record.text,
      sent: false,
      timestamp,
    };

    let appended = false;
    setMessages(prev => {
      if (Object.values(prev).some(chatMessages =>
        chatMessages.some(message => message.id === incomingMsg.id),
      )) {
        return prev;
      }
      appended = true;
      return {
        ...prev,
        [chatId]: [...(prev[chatId] || []), incomingMsg],
      };
    });

    setChats(prev => {
      const index = prev.findIndex(c => c.id === chatId || c.peerId === record.peerId);
      if (index >= 0) {
        const updated = prev.map((c, i) =>
          i === index
            ? {
                ...c,
                lastMessage: record.text,
                lastMessageTime: timestamp,
                unreadCount: appended ? c.unreadCount + 1 : c.unreadCount,
              }
            : c,
        );
        chatsRef.current = updated;
        return updated;
      }
      const newChat: Chat = {
        id: chatId,
        peerId: record.peerId,
        peerName: record.peerId,
        lastMessage: record.text,
        lastMessageTime: timestamp,
        unreadCount: 1,
      };
      chatsRef.current = [newChat, ...chatsRef.current];
      return [newChat, ...prev];
    });

    return chatId;
  }, []);

  // Restore encrypted history first.
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
              chat && typeof chat.id === 'string' && typeof chat.peerId === 'string',
            ).slice(0, 500)
          : [];
        const restoredMessages: Record<string, Message[]> = {};
        if (stored.messages && typeof stored.messages === 'object') {
          for (const [chatId, candidate] of Object.entries(stored.messages)) {
            if (!Array.isArray(candidate)) continue;
            restoredMessages[chatId] = (candidate as Message[])
              .filter(message =>
                message &&
                (typeof message.id === 'string' || typeof message.id === 'number') &&
                typeof message.text === 'string' &&
                message.text.length <= 2048,
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
      } catch (error) {
        console.error('Nie udało się odczytać zaszyfrowanej historii:', error);
      } finally {
        if (active) setHydrated(true);
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, []);

  // After hydration, drain the durable inbox (messages that arrived while the
  // WebView was asleep / before the listener registered). ACK only after the
  // records have been merged into state (and will be persisted by the effect
  // below). We keep it simple: a record is removed once ingestIncoming has
  // placed it; the next saveChatState persists it within 500ms.
  useEffect(() => {
    if (!hydrated || !(window as any)['__TAURI_INTERNALS__']) return;
    let active = true;

    const drain = async () => {
      try {
        const pending = await drainInbox();
        if (!active || pending.length === 0) return;
        const ids: string[] = [];
        for (const record of pending) {
          ingestIncoming(record);
          ids.push(record.id);
        }
        // Confirm to Rust only after scheduling the UI merge. The encrypted
        // history save happens in the persistence effect below.
        await ackInbox(ids);
      } catch (error) {
        console.warn('Nie udało się opróżnić trwałego inboxu:', error);
      }
    };

    void drain();

    // Re-drain when the app returns to the foreground (process may have stayed
    // alive while BLE kept receiving in the foreground service).
    const onVisible = () => {
      if (document.visibilityState === 'visible') void drain();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hydrated, ingestIncoming]);

  // Persist (encrypted) chat state shortly after any change.
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
      void saveChatState({ chats: chats.slice(0, 500), messages: persistedMessages }).catch(error => {
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

  const armDeliveryTimer = useCallback((msgId: string, chatId: string, timeoutMs = 60_000) => {
    const existing = deliveryTimersRef.current.get(msgId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      deliveryTimersRef.current.delete(msgId);
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(message =>
          message.id === msgId && !message.delivered
            ? {
                ...message,
                failed: true,
                queued: false,
                error: 'Brak potwierdzenia dostarczenia — wyślę ponownie po wznowieniu połączenia',
              }
            : message,
        ),
      }));
    }, timeoutMs);
    deliveryTimersRef.current.set(msgId, timer);
  }, []);

  const sendMessage = useCallback(
    async (chatId: string, text: string) => {
      const chat = chatsRef.current.find(c => c.id === chatId);
      const recipientId = chat?.peerId || chatId;

      // Optimistic local message with a local id; replaced with the signed
      // mesh id returned by Rust.
      const tempId = localId('pending-message');
      const msg: Message = {
        id: tempId,
        chatId,
        text,
        sent: true,
        timestamp: new Date(),
        queued: true,
      };

      setMessages(prev => ({
        ...prev,
        [chatId]: [...(prev[chatId] || []), msg],
      }));
      setChats(prev =>
        prev.map(c =>
          c.id === chatId ? { ...c, lastMessage: text, lastMessageTime: new Date() } : c,
        ),
      );

      try {
        const result = await meshSendText(recipientId, text);
        // Replace the local id with the signed mesh id so ACKs match.
        setMessages(prev => ({
          ...prev,
          [chatId]: (prev[chatId] || []).map(message =>
            message.id === tempId
              ? { ...message, id: result.msgId, queued: result.queued, failed: false }
              : message,
          ),
        }));
        // Arm a fallback watchdog from the moment the message is queued. If the
        // transport reports `transport_sent` it re-arms with a fresh timeout;
        // if nothing is heard at all the user sees a retryable failure.
        armDeliveryTimer(result.msgId, chatId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        setMessages(prev => ({
          ...prev,
          [chatId]: (prev[chatId] || []).map(message =>
            message.id === tempId ? { ...message, failed: true, queued: false, error } : message,
          ),
        }));
      }
    },
    [armDeliveryTimer],
  );

  const markRead = useCallback((chatId: string) => {
    setChats(prev => {
      const updated = prev.map(chat =>
        chat.id === chatId ? { ...chat, unreadCount: 0 } : chat,
      );
      chatsRef.current = updated;
      return updated;
    });
  }, []);

  useEffect(() => {
    // Live message while the WebView is active. Rust has already durably stored
    // it before emitting, so we only need to display it.
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
              return { ...m, delivered: true, queued: false, failed: false, error: undefined };
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

    // transport_sent = last BLE frame written; still not "delivered" (that
    // requires the signed ACK). Show a single check, not the double check.
    const transportSentPromise = onMessageTransportSent(({ msgId }) => {
      setMessages(prev => {
        const next = { ...prev };
        for (const [chatId, chatMessages] of Object.entries(next)) {
          if (!chatMessages.some(message => message.id === msgId)) continue;
          next[chatId] = chatMessages.map(message =>
            message.id === msgId
              ? { ...message, queued: false, failed: false, error: undefined }
              : message,
          );
          armDeliveryTimer(msgId, chatId);
          return next;
        }
        return prev;
      });
    });

    const transportFailedPromise = onMessageTransportFailed(({ msgId, reason }) => {
      setMessages(prev =>
        Object.fromEntries(
          Object.entries(prev).map(([chatId, chatMessages]) => [
            chatId,
            chatMessages.map(message =>
              message.id === msgId
                ? { ...message, queued: false, failed: true, error: reason }
                : message,
            ),
          ]),
        ),
      );
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

  const clearAllData = useCallback(() => {
    setChats([]);
    setMessages({});
    chatsRef.current = [];
  }, []);

  return {
    chats,
    messages,
    sendMessage,
    startChat,
    markRead,
    clearAllData,
  };
}
