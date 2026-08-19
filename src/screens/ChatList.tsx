import React, { useState } from 'react';
import { Edit, Shield } from 'lucide-react';
import SearchBar from '../components/SearchBar';
import ChatListItem from '../components/ChatListItem';
import type { Chat } from '../types';
import { motion } from 'motion/react';

interface Props {
  chats: Chat[];
  onOpenChat: (chatId: string, peerName: string) => void;
}

const ChatList: React.FC<Props> = ({ chats, onOpenChat }) => {
  const [search, setSearch] = useState('');

  const filtered = chats.filter(c =>
    c.peerName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      <div className="flex items-center justify-between px-6 py-4 pt-6">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Void</h1>
        <button className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-accent hover:bg-secondary/80 transition-colors">
          <Edit size={20} />
        </button>
      </div>

      <div className="flex justify-center px-4 pb-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/10 border border-accent/20">
          <Shield size={12} className="text-accent" />
          <span className="text-[10px] font-bold text-accent tracking-widest uppercase">Podpisany E2EE Mesh</span>
        </div>
      </div>

      <SearchBar
        placeholder="Szukaj..."
        value={search}
        onChange={setSearch}
      />

      {filtered.length === 0 ? (
        <motion.div 
          initial={{ opacity: 0 }} 
          animate={{ opacity: 1 }} 
          className="flex-1 flex flex-col items-center justify-center px-8 text-center"
        >
          <div className="w-20 h-20 bg-secondary/50 rounded-full flex items-center justify-center mb-6">
            <span className="text-3xl opacity-50">💬</span>
          </div>
          <h3 className="text-xl font-bold text-foreground mb-2">Brak rozmów</h3>
          <p className="text-muted-foreground text-sm">
            Dodaj kontakt w zakładce Kontakty,<br />aby rozpocząć bezpieczną rozmowę.
          </p>
        </motion.div>
      ) : (
        <div className="flex-1 overflow-y-auto pb-24 no-scrollbar">
          {filtered.map((chat, i) => (
            <motion.div 
              key={chat.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <ChatListItem
                chat={chat}
                onClick={() => onOpenChat(chat.id, chat.peerName)}
              />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChatList;
