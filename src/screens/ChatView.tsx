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
  
  const id = chatId || chat?.id || 'chat';
  const title = chatName || chat?.name || id;
  const msgList: Message[] = messages || chat?.messages || [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgList.length]);

  const handleSend = (text: string) => {
    if (onSend) onSend(id, text);
    if (onSendMessage) onSendMessage(id, text);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-background" data-testid="chat-view">
      {/* Header */}
      <div className="flex items-center gap-3 px-2 py-3 bg-background border-b border-border/10 sticky top-0 z-10 pt-safe h-16">
        <button 
          className="p-2 -ml-1 rounded-full text-accent hover:bg-secondary transition-colors md:hidden" 
          onClick={onBack} 
          aria-label="Wstecz"
        >
          <ChevronLeft size={28} strokeWidth={2.5} />
        </button>
        <Avatar name={title} size={40} online={true} />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0 ml-1">
          <span className="text-base font-bold text-foreground truncate">{title}</span>
          <div className="flex items-center gap-1 mt-0.5">
            <Shield size={10} className="text-emerald-500" />
            <span className="text-[10px] text-muted-foreground truncate uppercase tracking-widest font-bold">E2EE Mesh</span>
          </div>
        </div>
        <div className="flex items-center gap-1 mr-2">
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
              <MoreVertical size={24} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 no-scrollbar">
        {msgList.length === 0 && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center justify-center h-full text-center opacity-50 space-y-3"
          >
             <Shield size={32} className="text-muted-foreground" />
             <p className="text-xs text-muted-foreground">Wiadomości są zaszyfrowane E2EE (Antykwantowo)<br/>i przesyłane bezpiecznie.</p>
          </motion.div>
        )}
        
        <AnimatePresence initial={false}>
          {msgList.map((msg, index) => {
            const isSent = msg.sent ?? false;
            return (
              <motion.div
                key={msg.id || index}
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                layout
                transition={{ type: "spring", stiffness: 300, damping: 25 }}
                data-testid={isSent ? 'msg-bubble-sent' : 'msg-bubble-received'}
              >
                <ChatBubble
                  text={msg.text}
                  sent={isSent}
                  timestamp={formatTimestamp(msg.timestamp)}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <div data-testid="chat-input-bar">
        <MessageInput onSend={handleSend} />
      </div>
    </div>
  );
};

export { ChatView };
export default ChatView;
