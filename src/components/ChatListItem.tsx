import React from 'react';
import Avatar from './Avatar';
import type { Chat } from '../types';
import { motion } from 'motion/react';
import { Hash, Lock, ShieldCheck } from 'lucide-react';
import { formatMediaPreview } from '../utils/mediaCodec';

interface Props {
  chat: Chat;
  online?: boolean;
  verified?: boolean;
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

const ChatListItem: React.FC<Props> = ({ chat, online = false, verified = false, onClick }) => {
  const hasUnread = chat.unreadCount > 0;
  const isChannel = chat.kind === 'channel' || chat.peerId.startsWith('#');
  const isGroup = chat.kind === 'group' || chat.peerId.startsWith('GRP-');

  return (
    <motion.div 
      whileTap={{ scale: 0.98, backgroundColor: 'var(--color-secondary)' }}
      className="flex items-center px-4 py-3 gap-4 cursor-pointer transition-colors hover:bg-secondary/50 rounded-xl mx-2 my-1" 
      onClick={onClick} 
      role="button" 
      tabIndex={0}
    >
      <Avatar
        name={chat.peerName}
        avatarLetter={isChannel ? '#' : isGroup ? '🔒' : undefined}
        size={56}
        online={isChannel ? true : online}
      />
      <div className="flex-1 flex flex-col overflow-hidden gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {isChannel && <Hash size={14} className="text-accent shrink-0" />}
            {isGroup && <Lock size={13} className="text-emerald-500 shrink-0" />}
            <span className={`text-base truncate ${hasUnread ? 'font-bold text-foreground' : 'font-semibold text-foreground'}`}>
              {chat.peerName}
            </span>
            {verified && !isChannel && !isGroup && (
              <span title="Zweryfikowany kontakt (Safety Number)" className="text-emerald-500 shrink-0">
                <ShieldCheck size={15} />
              </span>
            )}
          </div>
          <span className={`text-xs flex-shrink-0 ${hasUnread ? 'font-bold text-accent' : 'text-muted-foreground'}`}>
            {formatTime(chat.lastMessageTime)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className={`text-sm truncate ${hasUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
            {chat.lastMessage
              ? formatMediaPreview(chat.lastMessage)
              : isChannel
              ? 'Otwarty kanał rozgłoszeniowy Mesh'
              : isGroup
              ? `Zaszyfrowana grupa E2EE (${chat.members?.length || 1} czł.)`
              : 'Brak wiadomości'}
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

