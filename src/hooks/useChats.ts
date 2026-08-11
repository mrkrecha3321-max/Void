import { useState, useCallback, useEffect, useRef } from 'react';
import { meshSendText, onMessageReceived, onPeerDiscovered, onMessageAckReceived } from '../api';
import type { Chat, Message, MessageReceivedPayload, PeerDiscoveredPayload, MessageAckPayload } from '../types';

const isSamePeerId = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
};

export function useChats() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});

  const chatsRef = useRef<Chat[]>(chats);
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  useEffect(() => {
    if (!(window as any)['__TAURI_INTERNALS__']) {
      const mockChatId = 'chat-mock-1';
      setChats([
        {
          id: mockChatId,
          peerId: 'usr_8392104',
          peerName: 'Alice',
          unreadCount: 0,
          lastMessage: 'Hej, czy Quantum E2EE już działa?',
          lastMessageTime: new Date(Date.now() - 1000 * 60 * 5),
        },
      ]);
      setMessages({
        [mockChatId]: [
          {
            id: 'msg-1',
            chatId: mockChatId,
            text: 'Hej, czy Quantum E2EE już działa?',
            sent: false,
            timestamp: new Date(Date.now() - 1000 * 60 * 5),
          }
        ]
      });
    }
  }, []);

  useEffect(() => {
    const unlistenPromise = onPeerDiscovered((payload: PeerDiscoveredPayload) => {
      if (!payload.id) return;
      const peerId = payload.id;
      const peerName = payload.name || peerId;

      setChats(prev => {
        const existingIndex = prev.findIndex(c => isSamePeerId(c.peerId, peerId) || c.id === peerId);
        if (existingIndex >= 0) {
          const existing = prev[existingIndex];
          if (existing.peerName === existing.peerId && peerName !== existing.peerId) {
            const updated = [...prev];
            updated[existingIndex] = { ...existing, peerId, peerName };
            chatsRef.current = updated;
            return updated;
          }
          if (existing.peerId !== peerId) {
            const updated = [...prev];
            updated[existingIndex] = { ...existing, peerId };
            chatsRef.current = updated;
            return updated;
          }
          return prev;
        }

        const chatId = 'chat-' + Date.now();
        const newChat: Chat = {
          id: chatId,
          peerId,
          peerName,
          unreadCount: 0,
        };
        const updated = [newChat, ...prev];
        chatsRef.current = updated;
        return updated;
      });
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten && unlisten());
    };
  }, []);

  const startChat = useCallback((peerId: string, peerName: string): string => {
    const existing = chatsRef.current.find(c => isSamePeerId(c.peerId, peerId) || c.id === peerId);
    if (existing) return existing.id;

    const chatId = 'chat-' + Date.now();
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

  const sendMessage = useCallback(async (chatId: string, text: string) => {
    const chat = chatsRef.current.find(c => c.id === chatId);
    const recipientId = chat?.peerId || chatId;
    
    // We create a temporary message with a local ID
    const tempId = Date.now().toString();
    const msg: Message = {
      id: tempId,
      chatId,
      text,
      sent: true,
      timestamp: new Date(),
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
      const msgId = await meshSendText(recipientId, text);
      // Replace the local ID with the real mesh ID so ACKs can match it
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map(m => m.id === tempId ? { ...m, id: msgId } : m),
      }));
    } catch (err) {
      console.error(err);
    }
  }, []);

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
      id: (Date.now() + 1).toString(),
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
    setChats(prev =>
      prev.map(c => (c.id === chatId ? { ...c, unreadCount: 0 } : c))
    );
  }, []);

  useEffect(() => {
    const unlistenPromise = onMessageReceived((payload: MessageReceivedPayload) => {
      const msgDate = new Date(payload.timestamp);
      const timestamp = isNaN(msgDate.getTime()) ? new Date() : msgDate;

      let chatId: string;
      const existing = chatsRef.current.find(c => isSamePeerId(c.peerId, payload.peerId) || c.id === payload.peerId);
      if (existing) {
        chatId = existing.id;
      } else {
        chatId = 'chat-' + Date.now();
      }

      const incomingMsg: Message = {
        id: payload.id || Date.now().toString(),
        chatId,
        text: payload.text,
        sent: false,
        timestamp,
      };

      setMessages(prev => ({
        ...prev,
        [chatId]: [...(prev[chatId] || []), incomingMsg],
      }));

      setChats(prev => {
        const index = prev.findIndex(c => c.id === chatId || isSamePeerId(c.peerId, payload.peerId));
        if (index >= 0) {
          return prev.map((c, i) =>
            i === index
              ? {
                  ...c,
                  peerId: payload.peerId,
                  lastMessage: payload.text,
                  lastMessageTime: timestamp,
                  unreadCount: c.unreadCount + 1,
                }
              : c
          );
        } else {
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
        }
      });
    });

    const unlistenAckPromise = onMessageAckReceived((payload: MessageAckPayload) => {
      setMessages(prev => {
        const next = { ...prev };
        let modified = false;
        
        for (const [cId, msgs] of Object.entries(next)) {
          const updatedMsgs = msgs.map(m => {
            if (m.id === payload.msgId) {
              modified = true;
              return { ...m, delivered: true };
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

    return () => {
      unlistenPromise.then(unlisten => unlisten && unlisten());
      unlistenAckPromise.then(unlisten => unlisten && unlisten());
    };
  }, []);

  const clearAllData = useCallback(() => {
    setChats([]);
    setMessages({});
    chatsRef.current = [];
  }, []);

  return { chats, messages, sendMessage, receiveMessage, startChat, markRead, clearAllData };
}
