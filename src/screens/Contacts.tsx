import React, { useState, useEffect, useRef } from 'react';
import Avatar from '../components/Avatar';
import type { Peer } from '../types';
import { Users, UserPlus, RadioReceiver, Hash, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { listen } from '@tauri-apps/api/event';

interface Props {
  peers: Peer[];
  onStartChat: (peerId: string, peerName: string) => void;
  onAddPeer: (peerId: string, name: string) => void;
  myNodeId?: string | null;
}

const Contacts: React.FC<Props> = ({ peers, onStartChat, onAddPeer, myNodeId }) => {
  const [copied, setCopied] = useState(false);
  const [showNfcModal, setShowNfcModal] = useState(false);
  const [showIdModal, setShowIdModal] = useState(false);
  const [nfcStatus, setNfcStatus] = useState<string>('');
  const [peerIdInput, setPeerIdInput] = useState('');
  const [peerNameInput, setPeerNameInput] = useState('');
  const nfcUnlistenRef = useRef<(() => void) | null>(null);

  // Listen for nfc_tag_read events from native NfcManager.kt when modal is open.
  // Web NFC API (NDEFReader) does NOT work in Tauri WebView — we use Tauri events instead.
  useEffect(() => {
    if (!showNfcModal) {
      if (nfcUnlistenRef.current) {
        nfcUnlistenRef.current();
        nfcUnlistenRef.current = null;
      }
      return;
    }

    setNfcStatus('Przybliż telefony do siebie...');

    // Subscribe to native NFC event: NfcManager.kt → Rust JNI → Tauri → here
    listen<{ payload: string }>('nfc_tag_read', (event) => {
      try {
        // payload can be { payload: "VORTEX:..." } or just the string
        const raw: string =
          (event.payload as any)?.payload ?? (event.payload as unknown as string);
        if (typeof raw !== 'string' || !raw.startsWith('VORTEX:')) {
          setNfcStatus('Niekompatybilny tag NFC');
          return;
        }
        // Format: VORTEX:nodeId:name  (name may contain colons)
        const parts = raw.split(':');
        const id   = parts[1] ?? '';
        const name = parts.slice(2).join(':') || id.slice(0, 8);
        setNfcStatus(`✅ Znaleziono: ${name}`);
        setTimeout(() => {
          setShowNfcModal(false);
          if (id) {
            onAddPeer(id, name);
            onStartChat(id, name);
          }
        }, 1200);
      } catch {
        setNfcStatus('Błąd odczytu NFC');
      }
    }).then(unlisten => {
      nfcUnlistenRef.current = unlisten;
    }).catch(() => {
      setNfcStatus('NFC niedostępne (tryb deweloperski)');
    });

    return () => {
      if (nfcUnlistenRef.current) {
        nfcUnlistenRef.current();
        nfcUnlistenRef.current = null;
      }
    };
  }, [showNfcModal, onAddPeer, onStartChat]);

  const handleNfcScan = () => {
    setShowNfcModal(true);
  };

  const handleAddById = (e: React.FormEvent) => {
    e.preventDefault();
    if (!peerIdInput) return;
    const name = peerNameInput || peerIdInput.slice(0, 8);
    onAddPeer(peerIdInput, name);
    onStartChat(peerIdInput, name);
    setShowIdModal(false);
    setPeerIdInput('');
    setPeerNameInput('');
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-background relative">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 pt-6">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Kontakty</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowIdModal(true)}
            className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-accent hover:bg-secondary/80 transition-colors"
            title="Dodaj po ID"
          >
            <Hash size={20} />
          </button>
          <button
            onClick={handleNfcScan}
            className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-accent hover:bg-secondary/80 transition-colors"
            title="Dodaj przez NFC"
          >
            <UserPlus size={20} />
          </button>
        </div>
      </div>

      {/* My Node ID Card */}
      <div className="mx-4 mb-4 mt-2 bg-secondary/40 border border-border/60 rounded-2xl px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex flex-col min-w-0">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-0.5">Mój Node ID</span>
          <span className="text-sm font-mono text-foreground truncate select-all">
            {myNodeId || 'Ładowanie...'}
          </span>
        </div>
        <button
          onClick={() => {
            if (myNodeId) {
              navigator.clipboard.writeText(myNodeId);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          }}
          className="shrink-0 px-3 py-1.5 rounded-xl bg-accent/10 border border-accent/30 text-accent text-xs font-semibold active:scale-95 transition-all"
          disabled={!myNodeId}
        >
          {copied ? '✓ Skopiowano' : 'Kopiuj'}
        </button>
      </div>

      {peers.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex-1 flex flex-col items-center justify-center px-8 text-center"
        >
          <div className="w-20 h-20 bg-secondary/50 rounded-full flex items-center justify-center mb-6">
            <Users size={36} className="text-muted-foreground opacity-50" />
          </div>
          <h3 className="text-xl font-bold text-foreground mb-2">Brak peerów w sieci</h3>
          <p className="text-muted-foreground text-sm">
            Dodaj peera przez ID lub skaner NFC.
          </p>
        </motion.div>
      ) : (
        <div className="flex-1 overflow-y-auto pb-24 px-2 no-scrollbar">
          {peers.map((peer, i) => (
            <motion.div
              key={peer.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="flex items-center px-4 py-3 gap-4 border-b border-border/50"
            >
              <Avatar name={peer.name} size={48} online={peer.online} />
              <div className="flex-1 flex flex-col overflow-hidden gap-0.5">
                <span className="text-base font-semibold text-foreground truncate">
                  {peer.name || peer.id.slice(0, 8) + '...'}
                </span>
                <span className={`text-xs ${peer.online ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                  {peer.online ? 'Online' : 'Offline'}
                </span>
              </div>
              <button
                className="px-4 py-1.5 rounded-full border border-accent text-accent text-sm font-semibold hover:bg-accent hover:text-white transition-colors"
                onClick={() => onStartChat(peer.id, peer.name || peer.id.slice(0, 8))}
              >
                Czat
              </button>
            </motion.div>
          ))}
        </div>
      )}

      {/* Add by ID Modal */}
      <AnimatePresence>
        {showIdModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-card w-full max-w-sm rounded-3xl p-6 shadow-2xl border border-border flex flex-col relative"
            >
              <button
                onClick={() => setShowIdModal(false)}
                className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
              >
                <X size={24} />
              </button>
              <h2 className="text-xl font-bold mb-6 text-center">Dodaj Kontakt (ID)</h2>
              <form onSubmit={handleAddById} className="flex flex-col gap-4">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground ml-2 mb-1 block uppercase tracking-wider">Node ID</label>
                  <input
                    type="text"
                    value={peerIdInput}
                    onChange={(e) => setPeerIdInput(e.target.value)}
                    placeholder="np. VX-A1B2C3D4"
                    className="w-full bg-secondary text-foreground rounded-2xl px-4 py-3 outline-none focus:ring-2 focus:ring-accent"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground ml-2 mb-1 block uppercase tracking-wider">Nazwa (Opcjonalnie)</label>
                  <input
                    type="text"
                    value={peerNameInput}
                    onChange={(e) => setPeerNameInput(e.target.value)}
                    placeholder="np. Jan Kowalski"
                    className="w-full bg-secondary text-foreground rounded-2xl px-4 py-3 outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full bg-accent text-white rounded-2xl py-3 mt-4 font-bold shadow-lg shadow-accent/20 active:scale-95 transition-transform"
                >
                  Dodaj Kontakt
                </button>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* NFC Modal Overlay */}
      <AnimatePresence>
        {showNfcModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-card w-full max-w-sm rounded-3xl p-6 shadow-2xl border border-border flex flex-col items-center text-center relative"
            >
              <button
                onClick={() => setShowNfcModal(false)}
                className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
              >
                <X size={24} />
              </button>
              <div className="w-20 h-20 rounded-full bg-accent/20 flex items-center justify-center mb-6 mt-4">
                <RadioReceiver size={40} className="text-accent animate-pulse" />
              </div>
              <h2 className="text-xl font-bold mb-2">Dodawanie przez NFC</h2>
              <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
                Zbliż swój telefon do telefonu drugiej osoby z włączoną aplikacją Void, aby nawiązać bezpieczne połączenie.
              </p>
              <div className="w-full bg-secondary/50 rounded-xl py-3 px-4 text-sm font-semibold text-accent min-h-[44px] flex items-center justify-center">
                {nfcStatus || 'Czekam...'}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Contacts;
