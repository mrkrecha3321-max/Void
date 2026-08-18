import React, { useEffect, useRef } from 'react';
import Avatar from '../components/Avatar';
import ChatBubble from '../components/ChatBubble';
import MessageInput from '../components/MessageInput';
import type { ChatNode, Message, PeerLinkStatus } from '../types';
import { isPeerOnline, peerLinkLabel } from '../peerLink';
import { ChevronLeft, Shield, MoreVertical } from 'lucide-react';

interface Props {
  chatId?: string;
  chatName?: string;
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

  const id = chatId || chat?.id || 'chat';
  const title = chatName || chat?.name || id;
  const msgList: Message[] = messages || chat?.messages || [];

  const scrollToBottom = (smooth: boolean) => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
  };

  useEffect(() => {
    scrollToBottom(msgList.length > 1);
  }, [msgList.length, msgList[msgList.length - 1]?.id]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const onResize = () => scrollToBottom(false);
    viewport.addEventListener('resize', onResize);
    return () => viewport.removeEventListener('resize', onResize);
  }, []);

  const handleSend = (text: string) => {
    if (onSend) onSend(id, text);
    if (onSendMessage) onSendMessage(id, text);
  };

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col h-full overflow-hidden bg-background" data-testid="chat-view">
      <div className="flex items-center gap-2 px-2 py-2 bg-background border-b border-border/10 shrink-0 pt-safe min-h-14">
        <button
          className="p-2 -ml-1 rounded-full text-accent hover:bg-secondary transition-colors md:hidden shrink-0"
          onClick={onBack}
          aria-label="Wstecz"
        >
          <ChevronLeft size={28} strokeWidth={2.5} />
        </button>
        <Avatar name={title} size={40} online={isPeerOnline(peerLinkStatus, peerOnline)} />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0 ml-1">
          <span className="text-base font-bold text-foreground truncate">{title}</span>
          <div className="flex items-center gap-1 mt-0.5 min-w-0">
            <Shield size={10} className={isPeerOnline(peerLinkStatus, peerOnline) ? 'text-emerald-500 shrink-0' : 'text-muted-foreground shrink-0'} />
            <span className="text-[10px] text-muted-foreground truncate uppercase tracking-widest font-bold">
              {peerLinkLabel(peerLinkStatus, peerOnline)} · E2EE
            </span>
          </div>
        </div>
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
              Wiadomości są szyfrowane E2EE<br />i podpisywane kluczem tożsamości.
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
    </div>
  );
};

export { ChatView };
export default ChatView;
