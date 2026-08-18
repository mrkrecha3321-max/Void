import React, { useState } from 'react';
import Avatar from '../components/Avatar';
import type { Peer } from '../types';
import { Users, UserPlus, Hash, X, QrCode, Camera, ScanLine, Settings } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { importContactCard } from '../api';
import {
  scan,
  cancel,
  checkPermissions,
  requestPermissions,
  openAppSettings,
  Format,
} from '@tauri-apps/plugin-barcode-scanner';

interface Props {
  peers: Peer[];
  onStartChat: (peerId: string, peerName: string) => void;
  onAddPeer: (peerId: string, name: string) => void | Promise<void>;
  myNodeId?: string | null;
}

type QrState = 'idle' | 'requesting' | 'scanning' | 'verified' | 'denied' | 'error';

const Contacts: React.FC<Props> = ({ peers, onStartChat, onAddPeer, myNodeId }) => {
  const [copied, setCopied] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [showIdModal, setShowIdModal] = useState(false);
  const [qrState, setQrState] = useState<QrState>('idle');
  const [qrMessage, setQrMessage] = useState('');
  const [peerIdInput, setPeerIdInput] = useState('');
  const [peerNameInput, setPeerNameInput] = useState('');

  const isTauri = !!(window as any)['__TAURI_INTERNALS__'];

  const startQrScan = async () => {
    setQrState('requesting');
    setQrMessage('Przygotowywanie aparatu...');

    if (!isTauri) {
      setQrState('error');
      setQrMessage('Skaner QR działa tylko w aplikacji mobilnej Void (Android/iOS). Na komputerze dodaj kontakt ręcznie po Node ID.');
      return;
    }

    try {
      let permission = await checkPermissions();
      if (permission !== 'granted') {
        permission = await requestPermissions();
      }
      if (permission !== 'granted') {
        setQrState('denied');
        setQrMessage('Aby zeskanować kod QR, zezwól aplikacji na dostęp do aparatu.');
        return;
      }

      setQrState('scanning');
      setQrMessage('Nakieruj aparat na kod QR profilu VOID2...');

      const result = await scan({
        cameraDirection: 'back',
        formats: [Format.QRCode],
        windowed: false,
      });

      const raw = result?.content ?? '';
      if (!raw.startsWith('VOID2:')) {
        setQrState('error');
        setQrMessage('To nie jest podpisany kod QR profilu Void (oczekiwano VOID2:...).');
        return;
      }

      setQrState('requesting');
      setQrMessage('Weryfikowanie podpisu profilu...');
      const contact = await importContactCard(raw);
      setQrState('verified');
      setQrMessage(`Zweryfikowano podpis: ${contact.name}`);

      // Close the native scanner view, then open the verified chat after a beat.
      cancel().catch(() => undefined);
      setTimeout(() => {
        setShowQrModal(false);
        setQrState('idle');
        onStartChat(contact.nodeId, contact.name);
      }, 650);
    } catch (error) {
      // User cancelled / backed out of the scanner — not a real error.
      const message = String(error ?? '');
      if (/cancel|denied|rejected/i.test(message)) {
        setShowQrModal(false);
        setQrState('idle');
        return;
      }
      setQrState('error');
      setQrMessage(`Nie udało się zeskanować kodu: ${message}`);
    }
  };

  const closeQrModal = () => {
    if (qrState === 'scanning') cancel().catch(() => undefined);
    setShowQrModal(false);
    setQrState('idle');
    setQrMessage('');
  };

  const handleAddById = async (e: React.FormEvent) => {
    e.preventDefault();
    const peerId = peerIdInput.trim().toUpperCase();
    if (!/^VX-[0-9A-F]{32}$/.test(peerId)) {
      window.alert('Node ID musi mieć format VX- i 32 znaki szesnastkowe.');
      return;
    }
    const name = (peerNameInput.trim() || peerId.slice(0, 11)).slice(0, 80);
    try {
      await onAddPeer(peerId, name);
      onStartChat(peerId, name);
      setShowIdModal(false);
      setPeerIdInput('');
      setPeerNameInput('');
    } catch (error) {
      window.alert(`Nie udało się dodać kontaktu: ${String(error)}`);
    }
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
            aria-label="Dodaj kontakt po Node ID"
          >
            <Hash size={20} />
          </button>
          <button
            onClick={() => {
              setQrState('idle');
              setQrMessage('');
              setShowQrModal(true);
              // Auto-start the scanner a tick later so the modal can render.
              setTimeout(() => { void startQrScan(); }, 150);
            }}
            className="w-10 h-10 rounded-full bg-accent text-white flex items-center justify-center hover:bg-accent/90 active:scale-95 transition-all shadow-md shadow-accent/20"
            title="Skanuj kod QR"
            aria-label="Skanuj kod QR kontaktu"
          >
            <QrCode size={20} />
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
          <h3 className="text-xl font-bold text-foreground mb-2">Brak kontaktów</h3>
          <p className="text-muted-foreground text-sm">
            Dodaj kontakt, skanując jego kod QR (ikona aparatu)<br />albo wpisując Node ID ręcznie.
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
                aria-label="Zamknij"
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

      {/* QR Scanner Modal */}
      <AnimatePresence>
        {showQrModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-card w-full max-w-sm rounded-3xl p-6 shadow-2xl border border-border flex flex-col items-center text-center relative"
            >
              <button
                onClick={closeQrModal}
                className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
                aria-label="Zamknij skaner"
              >
                <X size={24} />
              </button>

              <div className="w-20 h-20 rounded-full bg-accent/15 flex items-center justify-center mb-5 mt-2">
                {qrState === 'scanning' ? (
                  <ScanLine size={40} className="text-accent animate-pulse" />
                ) : qrState === 'denied' ? (
                  <Settings size={38} className="text-amber-500" />
                ) : qrState === 'verified' ? (
                  <QrCode size={40} className="text-emerald-500" />
                ) : (
                  <Camera size={38} className="text-accent" />
                )}
              </div>

              <h2 className="text-xl font-bold mb-2">
                {qrState === 'verified' ? 'Profil zweryfikowany' : 'Skaner QR'}
              </h2>

              <p className="text-muted-foreground mb-5 text-sm leading-relaxed min-h-[3rem]">
                {qrMessage || 'Zeskanuj podpisany kod QR profilu Void, aby dodać kontakt. Podpis jest weryfikowany w aplikacji.'}
              </p>

              <div className="w-full flex flex-col gap-2">
                {qrState === 'denied' && (
                  <button
                    onClick={() => { void openAppSettings().catch(() => undefined); }}
                    className="w-full bg-accent text-white rounded-2xl py-3 font-bold active:scale-95 transition-transform"
                  >
                    Otwórz ustawienia aparatu
                  </button>
                )}

                {(qrState === 'error' || qrState === 'denied') && isTauri && (
                  <button
                    onClick={() => { void startQrScan(); }}
                    className="w-full bg-secondary text-foreground rounded-2xl py-3 font-semibold active:scale-95 transition-transform"
                  >
                    Spróbuj ponownie
                  </button>
                )}

                <button
                  onClick={closeQrModal}
                  className="w-full text-muted-foreground rounded-2xl py-2.5 font-semibold hover:text-foreground transition-colors"
                >
                  Anuluj
                </button>
              </div>

              <p className="text-[11px] text-muted-foreground/70 mt-4 flex items-center gap-1">
                <UserPlus size={12} />
                Wolisz bez skanowania? Użyj ikony #, by dodać po Node ID.
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Contacts;
