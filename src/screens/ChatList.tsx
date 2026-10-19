import React, { useState } from 'react';
import { Edit, Shield, Users, Volume2, VolumeX, Lock, X, Check } from 'lucide-react';
import SearchBar from '../components/SearchBar';
import ChatListItem from '../components/ChatListItem';
import type { Chat, Peer } from '../types';
import { isPeerOnline, peerIdsMatch } from '../peerLink';
import { isTacticalAudioMuted, toggleTacticalAudioMuted, playPttClick } from '../utils/tacticalAudio';
import { motion, AnimatePresence } from 'motion/react';

interface Props {
  chats: Chat[];
  peers?: Peer[];
  onOpenChat: (chatId: string, peerName: string) => void;
  onNewChat?: () => void;
  onCreateGroup?: (name: string, members: string[]) => Promise<Chat>;
}

type FilterMode = 'all' | 'direct' | 'channels' | 'groups';

const ChatList: React.FC<Props> = ({ chats, peers = [], onOpenChat, onNewChat, onCreateGroup }) => {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [audioMuted, setAudioMuted] = useState<boolean>(() => isTacticalAudioMuted());
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [creatingGroup, setCreatingGroup] = useState(false);

  const filtered = chats.filter(c => {
    const matchesSearch = c.peerName.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;
    const isChannel = c.kind === 'channel' || c.peerId.startsWith('#');
    const isGroup = c.kind === 'group' || c.peerId.startsWith('GRP-');
    if (filter === 'channels') return isChannel;
    if (filter === 'groups') return isGroup;
    if (filter === 'direct') return !isChannel && !isGroup;
    return true;
  });

  const handleToggleAudio = () => {
    const nextMuted = toggleTacticalAudioMuted();
    setAudioMuted(nextMuted);
    if (!nextMuted) playPttClick();
  };

  const toggleMember = (peerId: string) => {
    setSelectedMembers(prev =>
      prev.includes(peerId) ? prev.filter(id => id !== peerId) : [...prev, peerId]
    );
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim() || !onCreateGroup || creatingGroup) return;
    setCreatingGroup(true);
    try {
      const created = await onCreateGroup(groupName.trim(), selectedMembers);
      setShowGroupModal(false);
      setGroupName('');
      setSelectedMembers([]);
      onOpenChat(created.id, created.peerName);
    } catch (err) {
      window.alert(`Nie udało się utworzyć grupy: ${String(err)}`);
    } finally {
      setCreatingGroup(false);
    }
  };

  const fullPeers = peers.filter(p => /^VX-[0-9A-F]{32}$/i.test(p.id));

  return (
    <div className="flex-1 flex flex-col h-full bg-background relative">
      <div className="flex items-center justify-between px-6 py-4 pt-6">
        <div className="flex items-center gap-2.5">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Void</h1>
          <span className="px-2 py-0.5 rounded-md bg-accent/15 text-accent text-[10px] font-mono font-bold uppercase tracking-wider border border-accent/30">
            AODV+DTN
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleToggleAudio}
            aria-label={audioMuted ? 'Włącz dźwięki taktyczne' : 'Wycisz dźwięki taktyczne'}
            title={audioMuted ? 'Dźwięki taktyczne wyciszone (kliknij by włączyć)' : 'Dźwięki taktyczne aktywne (Roger Beep / PTT)'}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
              audioMuted ? 'bg-secondary text-muted-foreground' : 'bg-accent/15 text-accent'
            }`}
          >
            {audioMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          {onCreateGroup && (
            <button
              type="button"
              onClick={() => setShowGroupModal(true)}
              aria-label="Nowa grupa E2EE"
              title="Utwórz zaszyfrowaną grupę E2EE"
              className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-accent hover:bg-secondary/80 transition-colors"
            >
              <Users size={18} />
            </button>
          )}
          <button
            onClick={onNewChat}
            aria-label="Nowa rozmowa"
            title="Nowa rozmowa"
            className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-accent hover:bg-secondary/80 transition-colors"
          >
            <Edit size={18} />
          </button>
        </div>
      </div>

      <div className="flex justify-center px-4 pb-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/10 border border-accent/20">
          <Shield size={12} className="text-accent" />
          <span className="text-[10px] font-bold text-accent tracking-widest uppercase">
            Podpisany E2EE Mesh · Dual-Cascade
          </span>
        </div>
      </div>

      <SearchBar
        placeholder="Szukaj rozmów, #kanałów lub grup..."
        value={search}
        onChange={setSearch}
      />

      <div className="flex items-center gap-1.5 px-4 pb-2 overflow-x-auto no-scrollbar">
        {([
          { id: 'all', label: 'Wszystkie' },
          { id: 'direct', label: '1:1' },
          { id: 'channels', label: 'Kanały #' },
          { id: 'groups', label: 'Grupy 🔒' },
        ] as const).map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={`px-3 py-1 rounded-full text-xs font-bold transition-colors shrink-0 ${
              filter === tab.id
                ? 'bg-accent text-white shadow-sm'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

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
            Dodaj kontakt w zakładce Kontakty lub wybierz otwarty kanał <strong className="text-accent">#ogolny</strong>.
          </p>
        </motion.div>
      ) : (
        <div className="flex-1 overflow-y-auto pb-24 no-scrollbar">
          {filtered.map((chat, i) => {
            const matchingPeer = peers.find(
              peer => peerIdsMatch(peer.id, chat.peerId) || peerIdsMatch(peer.id, chat.id)
            );
            const online = matchingPeer ? isPeerOnline(matchingPeer.linkStatus, matchingPeer.online) : false;
            return (
              <motion.div 
                key={chat.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
              >
                <ChatListItem
                  chat={chat}
                  online={online}
                  verified={matchingPeer?.verified}
                  onClick={() => onOpenChat(chat.id, chat.peerName)}
                />
              </motion.div>
            );
          })}
        </div>
      )}

      <AnimatePresence>
        {showGroupModal && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-sm bg-secondary border border-border rounded-3xl p-5 shadow-2xl flex flex-col gap-4 max-h-[85vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lock size={18} className="text-emerald-500" />
                  <h2 className="text-lg font-bold text-foreground">Nowa Grupa E2EE</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setShowGroupModal(false)}
                  className="p-1.5 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <X size={20} />
                </button>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Tworzy 256-bitowy klucz grupowy (AES-256-GCM + ChaCha20-Poly1305) i rozsyła go zaszyfrowanym kanałem E2EE do wybranych członków.
              </p>
              <form onSubmit={handleCreateGroup} className="flex flex-col gap-3">
                <div>
                  <label className="text-xs font-bold uppercase text-muted-foreground">Nazwa grupy</label>
                  <input
                    type="text"
                    value={groupName}
                    onChange={e => setGroupName(e.target.value.slice(0, 60))}
                    placeholder="np. Patrol Alfa / Sztab"
                    className="mt-1 w-full bg-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-accent"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase text-muted-foreground">
                    Członkowie ({selectedMembers.length} wybranych)
                  </label>
                  {fullPeers.length === 0 ? (
                    <p className="text-xs text-muted-foreground mt-1.5 bg-background/50 p-3 rounded-xl border border-border/50">
                      Brak sparowanych kontaktów z pełnym kluczem X25519. Możesz utworzyć grupę teraz i zaprosić węzły później.
                    </p>
                  ) : (
                    <div className="mt-1.5 max-h-40 overflow-y-auto flex flex-col gap-1.5 pr-1">
                      {fullPeers.map(peer => {
                        const checked = selectedMembers.includes(peer.id);
                        return (
                          <button
                            key={peer.id}
                            type="button"
                            onClick={() => toggleMember(peer.id)}
                            className={`flex items-center justify-between px-3 py-2 rounded-xl border text-left text-xs transition-colors ${
                              checked
                                ? 'bg-accent/15 border-accent text-foreground font-bold'
                                : 'bg-background/60 border-border/50 text-muted-foreground'
                            }`}
                          >
                            <span className="truncate">{peer.name || peer.id.slice(0, 12)}</span>
                            {checked && <Check size={15} className="text-accent shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!groupName.trim() || creatingGroup}
                  className="mt-2 w-full bg-accent text-white rounded-xl py-3 text-sm font-bold disabled:opacity-50"
                >
                  {creatingGroup ? 'Generowanie kluczy...' : 'Utwórz i wyślij klucze E2EE'}
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ChatList;

