import React, { useEffect, useRef, useState } from 'react';
import Avatar from '../components/Avatar';
import ChatBubble from '../components/ChatBubble';
import MessageInput from '../components/MessageInput';
import type { ChatNode, Message, PeerLinkStatus, SafetyNumberInfo } from '../types';
import { getSafetyNumber, setPeerVerified } from '../api';
import { isPeerOnline, peerLinkLabel } from '../peerLink';
import { ChevronLeft, Shield, ShieldCheck, Fingerprint, MoreVertical, Hash, Lock, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

interface Props {
  chatId?: string;
  chatName?: string;
  peerId?: string;
  peerVerified?: boolean;
  chatKind?: 'direct' | 'channel' | 'group';
  groupMembersCount?: number;
  messages?: Message[];
  chat?: ChatNode;
  onBack: () => void;
  onSend?: (chatId: string, text: string) => void;
  onSendMessage?: (chatId: string, text: string) => void;
  onRetry?: (chatId: string, message: Message) => void;
  onOpenSettings?: () => void;
  peerOnline?: boolean;
  peerLinkStatus?: PeerLinkStatus;
}

function formatTimestamp(date: Date | string): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  return isNaN(d.getTime()) ? String(date) : d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

const ChatView: React.FC<Props> = ({
  chatId,
  chatName,
  peerId,
  peerVerified = false,
  chatKind,
  groupMembersCount,
  messages,
  chat,
  onBack,
  onSend,
  onSendMessage,
  onRetry,
  onOpenSettings,
  peerOnline,
  peerLinkStatus,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  const [safetyInfo, setSafetyInfo] = useState<SafetyNumberInfo | null>(null);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  const [verifiedState, setVerifiedState] = useState<boolean>(peerVerified);

  useEffect(() => {
    setVerifiedState(peerVerified);
  }, [peerVerified, peerId]);

  const id = chatId || chat?.id || 'chat';
  const title = chatName || chat?.name || id;
  const resolvedPeerId = peerId || id;
  const isChannel = chatKind === 'channel' || resolvedPeerId.startsWith('#');
  const isGroup = chatKind === 'group' || resolvedPeerId.startsWith('GRP-');
  const isDirectFullPeer = !isChannel && !isGroup && /^VX-[0-9A-F]{32}$/i.test(resolvedPeerId);
  const msgList: Message[] = messages || chat?.messages || [];

  const scrollToBottom = (smooth: boolean) => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
  };

  const isNearBottom = () => {
    const list = listRef.current;
    if (!list) return true;
    return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  };

  // Track whether the user is reading the newest messages so automatic
  // scrolling never yanks them away from older parts of the conversation.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      stickToBottomRef.current = isNearBottom();
    };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => list.removeEventListener('scroll', onScroll);
  }, []);

  // Opening a conversation always starts at the newest messages.
  useEffect(() => {
    stickToBottomRef.current = true;
    scrollToBottom(false);
  }, [id]);

  // New messages only auto-scroll when the user was already at the bottom.
  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom(msgList.length > 1);
    }
  }, [msgList.length, msgList[msgList.length - 1]?.id]);

  // Keyboard open/close (and rotation) changes the available height; keep the
  // newest messages visible only when the user was already reading them.
  useEffect(() => {
    const viewport = window.visualViewport;
    const onResize = () => {
      if (stickToBottomRef.current) {
        scrollToBottom(false);
      }
    };
    if (viewport) {
      viewport.addEventListener('resize', onResize);
    }
    window.addEventListener('resize', onResize);
    return () => {
      if (viewport) {
        viewport.removeEventListener('resize', onResize);
      }
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const handleSend = (text: string) => {
    if (onSend) onSend(id, text);
    if (onSendMessage) onSendMessage(id, text);
  };

  const handleOpenSafety = async () => {
    if (!isDirectFullPeer) return;
    setShowSafetyModal(true);
    setSafetyError(null);
    try {
      const info = await getSafetyNumber(resolvedPeerId);
      setSafetyInfo(info);
      setVerifiedState(info.verified);
    } catch (err) {
      setSafetyError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleVerified = async () => {
    if (!isDirectFullPeer) return;
    const next = !verifiedState;
    try {
      await setPeerVerified(resolvedPeerId, next);
      setVerifiedState(next);
      if (safetyInfo) {
        setSafetyInfo({ ...safetyInfo, verified: next });
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col h-full overflow-hidden bg-background relative" data-testid="chat-view">
      <div className="flex items-center gap-2 px-2 py-2 bg-background border-b border-border/10 shrink-0 pt-safe min-h-14">
        <button
          className="p-2 -ml-1 rounded-full text-accent hover:bg-secondary transition-colors md:hidden shrink-0"
          onClick={onBack}
          aria-label="Wstecz"
        >
          <ChevronLeft size={28} strokeWidth={2.5} />
        </button>
        <Avatar
          name={title}
          avatarLetter={isChannel ? '#' : isGroup ? '🔒' : undefined}
          size={40}
          online={isChannel ? true : isPeerOnline(peerLinkStatus, peerOnline)}
        />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0 ml-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-base font-bold text-foreground truncate">{title}</span>
            {verifiedState && isDirectFullPeer && (
              <span title="Zweryfikowany Numer Bezpieczeństwa" className="text-emerald-500 shrink-0">
                <ShieldCheck size={16} />
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5 min-w-0">
            {isChannel ? (
              <>
                <Hash size={10} className="text-accent shrink-0" />
                <span className="text-[10px] text-muted-foreground truncate uppercase tracking-widest font-bold">
                  Kanał Otwarty Mesh · 32 Skoki
                </span>
              </>
            ) : isGroup ? (
              <>
                <Lock size={10} className="text-emerald-500 shrink-0" />
                <span className="text-[10px] text-muted-foreground truncate uppercase tracking-widest font-bold">
                  Grupa E2EE ({groupMembersCount || 1} czł.) · Dual-Cascade
                </span>
              </>
            ) : (
              <>
                <Shield size={10} className={isPeerOnline(peerLinkStatus, peerOnline) ? 'text-emerald-500 shrink-0' : 'text-muted-foreground shrink-0'} />
                <span className="text-[10px] text-muted-foreground truncate uppercase tracking-widest font-bold">
                  {peerLinkLabel(peerLinkStatus, peerOnline)} · {verifiedState ? 'Zweryfikowany E2EE' : 'E2EE + DTN'}
                </span>
              </>
            )}
          </div>
        </div>
        {isDirectFullPeer && (
          <button
            type="button"
            onClick={handleOpenSafety}
            className={`p-2 rounded-full transition-colors shrink-0 ${
              verifiedState ? 'text-emerald-500 bg-emerald-500/10' : 'text-accent hover:bg-secondary'
            }`}
            aria-label="Numer Bezpieczeństwa (Safety Number)"
            title="Sprawdź 60-cyfrowy Numer Bezpieczeństwa (Ochrona przed MITM)"
          >
            <Fingerprint size={20} />
          </button>
        )}
        {onOpenSettings && (
          <button
            className="p-2 rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors shrink-0"
            aria-label="Ustawienia"
            onClick={onOpenSettings}
          >
            <MoreVertical size={24} />
          </button>
        )}
      </div>

      <div
        ref={listRef}
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-3 py-3 no-scrollbar"
      >
        {msgList.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center opacity-50 space-y-3 px-6">
            <Shield size={32} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {isChannel
                ? 'Otwarty kanał rozgłoszeniowy. Wiadomości trafiają do wszystkich węzłów w promieniu 32 skoków.'
                : isGroup
                ? 'Zaszyfrowana grupa E2EE. Wiadomości są szyfrowane wspólnym kluczem 256-bit i podpisywane Ed25519.'
                : 'Wiadomości są szyfrowane E2EE (AES-256-GCM + ChaCha20-Poly1305) i dostarczane również offline przez kurierów DTN.'}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3 w-full min-w-0">
          {msgList.map((msg, index) => {
            const isSent = msg.sent ?? false;
            return (
              <div
                key={msg.clientKey || msg.id || index}
                className="w-full min-w-0"
                data-testid={isSent ? 'msg-bubble-sent' : 'msg-bubble-received'}
              >
                <ChatBubble
                  text={msg.text}
                  sent={isSent}
                  timestamp={formatTimestamp(msg.timestamp)}
                  delivered={msg.delivered}
                  failed={msg.failed}
                  queued={msg.queued}
                  transmitting={msg.transmitting || msg.status === 'transmitting'}
                  error={msg.error}
                  senderName={(isChannel || isGroup) && !isSent ? (msg.senderName || msg.senderId?.slice(0, 11)) : undefined}
                  onRetry={onRetry && isSent && msg.failed ? () => onRetry(id, msg) : undefined}
                />
              </div>
            );
          })}
        </div>
        <div ref={messagesEndRef} className="h-1 shrink-0" />
      </div>

      <div className="shrink-0 min-w-0" data-testid="chat-input-bar">
        <MessageInput onSend={handleSend} />
      </div>

      {showSafetyModal && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-secondary border border-border rounded-3xl p-5 shadow-2xl flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Fingerprint size={20} className="text-accent" />
                <h3 className="text-base font-bold text-foreground">Numer Bezpieczeństwa</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSafetyModal(false)}
                className="p-1.5 rounded-full text-muted-foreground hover:text-foreground"
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
              Porównaj poniższe 60 cyfr lub 6 słów taktycznych z ekranem rozmówcy (twarzą w twarz lub przez radio). Zgodność gwarantuje brak podsłuchu MITM.
            </p>

            {safetyError ? (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400">
                {safetyError}
              </div>
            ) : safetyInfo ? (
              <>
                <div className="flex justify-center bg-white p-3 rounded-2xl mx-auto">
                  <QRCodeSVG
                    value={`VOID-SAFETY:${resolvedPeerId}:${safetyInfo.digits}`}
                    size={132}
                    level="M"
                  />
                </div>

                <div className="bg-background/80 border border-border rounded-2xl p-3 font-mono text-xs text-center tracking-widest leading-relaxed text-foreground select-all">
                  {[0, 20, 40].map((offset) => {
                    const rowDigits = safetyInfo.digits.replace(/\s+/g, '').slice(offset, offset + 20);
                    const blocks = rowDigits.match(/.{1,5}/g)?.join(' ') || rowDigits;
                    return <div key={offset}>{blocks}</div>;
                  })}
                </div>

                <div className="bg-accent/10 border border-accent/30 rounded-2xl p-2.5 text-center">
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground block mb-1">
                    6 Słów Kontrolnych (Radio / Głos)
                  </span>
                  <span className="text-xs font-mono font-bold text-accent tracking-wider">
                    {Array.isArray(safetyInfo.words) ? safetyInfo.words.join(' · ') : String(safetyInfo.words)}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleToggleVerified}
                  className={`w-full py-3 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-colors ${
                    verifiedState
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                      : 'bg-accent text-white shadow-md'
                  }`}
                >
                  <ShieldCheck size={16} />
                  {verifiedState ? 'Zweryfikowano (Kliknij by cofnąć)' : 'Oznacz kontakt jako Zweryfikowany'}
                </button>
              </>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground animate-pulse">
                Obliczanie kryptograficznego odcisku SHA-256...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export { ChatView };
export default ChatView;

