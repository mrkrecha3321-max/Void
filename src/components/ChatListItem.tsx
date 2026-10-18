import React from 'react';
import Avatar from './Avatar';
import type { Chat } from '../types';
import { motion } from 'motion/react';

interface Props {
  chat: Chat;
  online?: boolean;
  onClick: () => void;
}

function formatTime(date?: Date | string): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  } else if (days === 1) {
    return 'Wczoraj';
  } else if (days < 7) {
    return d.toLocaleDateString('pl-PL', { weekday: 'short' });
  } else {
    return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
  }
}

const ChatListItem: React.FC<Props> = ({ chat, online = false, onClick }) => {
  const hasUnread = chat.unreadCount > 0;
  return (
    <motion.div 
      whileTap={{ scale: 0.98, backgroundColor: 'var(--color-secondary)' }}
      className="flex items-center px-4 py-3 gap-4 cursor-pointer transition-colors hover:bg-secondary/50 rounded-xl mx-2 my-1" 
      onClick={onClick} 
      role="button" 
      tabIndex={0}
    >
      <Avatar name={chat.peerName} size={56} online={online} />
      <div className="flex-1 flex flex-col overflow-hidden gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-base truncate ${hasUnread ? 'font-bold text-foreground' : 'font-semibold text-foreground'}`}>
            {chat.peerName}
          </span>
          <span className={`text-xs flex-shrink-0 ${hasUnread ? 'font-bold text-accent' : 'text-muted-foreground'}`}>
            {formatTime(chat.lastMessageTime)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className={`text-sm truncate ${hasUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
            {chat.lastMessage || 'Brak wiadomości'}
          </p>
          {hasUnread && (
            <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0">
              {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default ChatListItem;
