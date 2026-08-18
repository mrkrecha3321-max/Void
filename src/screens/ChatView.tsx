import React, { useEffect, useRef } from 'react';
import Avatar from '../components/Avatar';
import ChatBubble from '../components/ChatBubble';
import MessageInput from '../components/MessageInput';
import type { ChatNode, Message } from '../types';
import { Phone, Video, ChevronLeft, Shield, MoreVertical } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Props {
  chatId?: string;
  chatName?: string;
  messages?: Message[];
  chat?: ChatNode;
  onBack: () => void;
  onSend?: (chatId: string, text: string) => void;
  onSendMessage?: (chatId: string, text: string) => void;
  onOpenSettings?: () => void;
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
  onOpenSettings,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const id = chatId || chat?.id || 'chat';
  const title = chatName || chat?.name || id;
  const msgList: Message[] = messages || chat?.messages || [];

  useEffect(() => {
    const el = messagesEndRef.current;
    if (!el) return;
    // Avoid hijacking the UI if the user scrolled up to read history.
    const container = listRef.current;
    const nearBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight < 160
      : true;
    if (nearBottom) el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgList.length]);

  const handleSend = (text: string) => {
    if (onSend) onSend(id, text);
    if (onSendMessage) onSendMessage(id, text);
  };

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-background" data-testid="chat-view">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 sm:px-3 bg-background border-b border-border/10 shrink-0 pt-safe">
        <button
          className="p-2 -ml-1 rounded-full text-accent hover:bg-secondary transition-colors md:hidden"
          onClick={onBack}
          aria-label="Wstecz"
        >
          <ChevronLeft size={28} strokeWidth={2.5} />
        </button>
        <Avatar name={title} size={40} online={true} />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0 ml-1 py-2">
          <span className="text-base font-bold text-foreground truncate">{title}</span>
          <div className="flex items-center gap-1 mt-0.5">
            <Shield size={10} className="text-emerald-500" />
            <span className="text-[10px] text-muted-foreground truncate uppercase tracking-widest font-bold">E2EE Mesh</span>
          </div>
        </div>
        <div className="flex items-center gap-1 mr-1 sm:mr-2">
          <button className="p-2 rounded-full text-accent hover:bg-secondary transition-colors hidden sm:flex" aria-label="Połączenie głosowe">
            <Phone size={22} />
          </button>
          <button className="p-2 rounded-full text-accent hover:bg-secondary transition-colors hidden sm:flex" aria-label="Połączenie wideo">
            <Video size={24} />
          </button>
          {onOpenSettings && (
            <button
              className="p-2 rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors ml-1"
              aria-label="Ustawienia"
              onClick={onOpenSettings}
            >
              <MoreVertical size={22} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 no-scrollbar flex flex-col">
        {msgList.length === 0 && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="m-auto flex flex-col items-center justify-center text-center opacity-60 space-y-3 py-10"
          >
            <Shield size={32} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground max-w-[260px]">Wiadomości są szyfrowane E2EE<br />i podpisywane kluczem tożsamości.</p>
          </motion.div>
        )}

        <AnimatePresence initial={false}>
          {msgList.map((msg, index) => {
            const isSent = msg.sent ?? false;
            return (
              <ChatBubble
                key={msg.id || index}
                text={msg.text}
                sent={isSent}
                timestamp={formatTimestamp(msg.timestamp)}
                delivered={msg.delivered}
                failed={msg.failed}
                queued={msg.queued}
                error={msg.error}
              />
            );
          })}
        </AnimatePresence>
        <div ref={messagesEndRef} className="h-px w-full" />
      </div>

      {/* Input Bar */}
      <div data-testid="chat-input-bar" className="shrink-0">
        <MessageInput onSend={handleSend} />
      </div>
    </div>
  );
};

export { ChatView };
export default ChatView;
