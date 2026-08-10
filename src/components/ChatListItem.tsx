import React from 'react';
import Avatar from './Avatar';
import type { Chat } from '../types';
import { motion } from 'motion/react';

interface Props {
  chat: Chat;
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

const ChatListItem: React.FC<Props> = ({ chat, onClick }) => {
  return (
    <motion.div 
      whileTap={{ scale: 0.98, backgroundColor: 'var(--color-secondary)' }}
      className="flex items-center px-4 py-3 gap-4 cursor-pointer transition-colors hover:bg-secondary/50 rounded-xl mx-2 my-1" 
      onClick={onClick} 
      role="button" 
      tabIndex={0}
    >
      <Avatar name={chat.peerName} size={56} online={false} />
      <div className="flex-1 flex flex-col overflow-hidden gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-base font-semibold text-foreground truncate">{chat.peerName}</span>
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {formatTime(chat.lastMessageTime)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground truncate">
          {chat.lastMessage || 'Brak wiadomości'}
        </p>
      </div>
    </motion.div>
  );
};

export default ChatListItem;
