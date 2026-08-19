import React, { useState } from 'react';
import Avatar from '../components/Avatar';
import {
  exportIdentityBackup,
  getContactCard,
  importIdentityBackup,
  meshSendSos,
  setNodeName,
  triggerPanic,
} from '../api';
import type { Theme } from '../hooks/useTheme';
import { useSettings } from '../hooks/useSettings';
import { 
  Moon, Bell, Info, Settings, ShieldAlert, Cpu, 
  Radio, Zap, Shield, EyeOff, MessageSquareOff, Trash2, 
  Vibrate, Volume2, AlertTriangle, Send, MapPin, X, ChevronLeft,
  Download, Key, Upload
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { useProfile } from '../hooks/useProfile';
import { getVersion } from '@tauri-apps/api/app';
import { checkPermissions, getCurrentPosition, requestPermissions } from '@tauri-apps/plugin-geolocation';

interface Props {
  theme: Theme;
  toggleTheme: () => void;
  connected: boolean;
  connectedAddresses?: string[];
  nodeId: string | null;
  meshError: string | null;
  onPanic?: () => void;
}

const MenuScreen: React.FC<Props> = ({
  theme,
  toggleTheme,
  connected,
  connectedAddresses = [],
  nodeId,
  meshError,
  onPanic,
}) => {
  const [showSettings, setShowSettings] = useState(false);
  const { settings, updateSetting } = useSettings();
  const { profile, updateProfile } = useProfile();
  const [editProfile, setEditProfile] = useState(false);
  const [tempName, setTempName] = useState('');
  const [tempAvatar, setTempAvatar] = useState('');
  const [showBackup, setShowBackup] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [backupConfirmation, setBackupConfirmation] = useState('');
  const [backupImport, setBackupImport] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState('');

  const [showSos, setShowSos] = useState(false);
  const [sosName, setSosName] = useState('');
  const [sosDesc, setSosDesc] = useState('');
  const [sendingSos, setSendingSos] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [contactCard, setContactCard] = useState('');

  React.useEffect(() => {
    getVersion().then(v => setAppVersion(v)).catch(console.error);
  }, []);

  React.useEffect(() => {
    if (!(window as any)['__TAURI_INTERNALS__']) {
      setContactCard(nodeId || '');
      return;
    }
    getContactCard().then(setContactCard).catch(error => {
      console.error('Nie udało się utworzyć podpisanej wizytówki:', error);
      setContactCard('');
    });
  }, [nodeId, profile.displayName]);

  const handleExportBackup = async () => {
    if (backupPassword.length < 12 || backupPassword !== backupConfirmation) {
      setBackupError('Hasło musi mieć minimum 12 znaków i oba pola muszą być identyczne.');
      return;
    }
    setBackupBusy(true);
    setBackupError('');
    try {
      const backupJson = await exportIdentityBackup(backupPassword);
      const blob = new Blob([backupJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `void-identity-${nodeId || 'backup'}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setBackupPassword('');
      setBackupConfirmation('');
      setShowBackup(false);
    } catch (error) {
      setBackupError(String(error));
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportBackup = async () => {
    if (!backupImport || backupPassword.length < 12) {
      setBackupError('Wybierz plik i podaj hasło kopii.');
      return;
    }
    if (!window.confirm('Import zastąpi obecną tożsamość i usunie lokalne czaty oraz piny. Kontynuować?')) return;
    setBackupBusy(true);
    setBackupError('');
    try {
      await importIdentityBackup(backupImport, backupPassword);
      localStorage.clear();
      sessionStorage.clear();
      window.alert('Tożsamość została przywrócona. Aplikacja zostanie zamknięta.');
    } catch (error) {
      setBackupError(String(error));
      setBackupBusy(false);
    }
  };

  const handlePanic = async () => {
    const confirmed = window.confirm(
      'Czy na pewno?\n\nTo trwale usunie tożsamość kryptograficzną. Aplikacja zostanie zamknięta, a przy następnym uruchomieniu utworzy nowy Node ID.'
    );
    if (!confirmed) return;

    try {
      await triggerPanic();
      onPanic?.();
      localStorage.clear();
      sessionStorage.clear();
      window.alert('Tożsamość została usunięta. Aplikacja zostanie zamknięta.');
    } catch (error) {
      window.alert(`Nie udało się usunąć tożsamości: ${String(error)}`);
    }
  };

  const handleSendSos = async () => {
    if (!sosName.trim() || !sosDesc.trim() || sendingSos) return;
    setSendingSos(true);
    try {
      let lat: number | undefined;
      let lon: number | undefined;
      try {
        let permissions = await checkPermissions();
        if (permissions.location === 'prompt' || permissions.location === 'prompt-with-rationale') {
          permissions = await requestPermissions(['location', 'coarseLocation']);
        }
        if (permissions.location === 'granted' || permissions.coarseLocation === 'granted') {
          const position = await getCurrentPosition({
            enableHighAccuracy: true,
            timeout: 8_000,
            maximumAge: 30_000,
          });
          lat = position.coords.latitude;
          lon = position.coords.longitude;
        }
      } catch (locationError) {
        console.warn('SOS zostanie wysłany bez lokalizacji:', locationError);
      }

      await meshSendSos(sosName.trim(), sosDesc.trim(), lat, lon);
      setShowSos(false);
      setSosName('');
      setSosDesc('');
      window.alert('Podpisany sygnał SOS został zakolejkowany w sieci Mesh.');
    } catch (error) {
      window.alert(`Nie udało się wysłać SOS: ${String(error)}`);
    } finally {
      setSendingSos(false);
    }
  };


  const renderToggle = (
    icon: React.ReactNode, 
    title: string, 
    subtitle: string, 
    value: boolean, 
    onChange: (val: boolean) => void,
    danger = false
  ) => (
    <div 
      className="flex items-center px-6 py-4 cursor-pointer hover:bg-secondary/30 transition-colors active:bg-secondary/50" 
      onClick={() => onChange(!value)} 
      role="button" 
      tabIndex={0}
    >
      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${danger ? 'bg-red-500/10 text-red-500' : 'bg-accent/10 text-accent'}`}>
        {icon}
      </div>
      <div className="flex-1 ml-4 flex flex-col pr-4">
        <span className={`text-base font-semibold ${danger ? 'text-red-500' : 'text-foreground'}`}>{title}</span>
        <span className="text-sm text-muted-foreground leading-tight mt-0.5">{subtitle}</span>
      </div>
      
      <div className={`w-12 h-6 rounded-full p-1 transition-colors ${value ? (danger ? 'bg-red-500' : 'bg-accent') : 'bg-secondary border border-border/50'}`}>
        <motion.div 
          className={`w-4 h-4 rounded-full shadow-sm ${value ? 'bg-white' : 'bg-muted-foreground'}`}
          animate={{ x: value ? 24 : 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
        />
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-background relative overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 pt-6">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Menu</h1>
        <button 
          className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-accent hover:bg-secondary/80 transition-colors"
          onClick={() => setShowSettings(true)}
        >
          <Settings size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-24 no-scrollbar">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center px-6 py-5 gap-5 border-b border-border/50 bg-secondary/20"
        >
          <Avatar name={profile.displayName || "Void User"} avatarLetter={profile.avatarLetter} size={72} online={true} />
          <div className="flex-1 flex flex-col min-w-0">
            <span className="text-xl font-bold text-foreground">{profile.displayName || "Mój węzeł"}</span>
            <div className="flex items-center gap-1.5 mt-1 text-muted-foreground">
              <Cpu size={14} className="text-accent" />
              <button onClick={() => { navigator.clipboard.writeText(nodeId || ""); alert("Skopiowano Node ID do schowka!"); }} className="text-[11px] font-mono tracking-wider truncate uppercase hover:text-foreground active:scale-95 transition-all text-left">{nodeId || "Trwa ładowanie..."}</button>
            </div>
          </div>
        </motion.div>

        <div className="px-6 py-3 border-b border-border/50 bg-secondary/10 flex items-center gap-2.5 text-sm font-medium">
          <span className={`w-2.5 h-2.5 rounded-full ${meshError ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]' : connected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.5)] animate-pulse'}`} />
          <span className="text-muted-foreground">
            {meshError
              ? 'Błąd połączenia'
              : connected
              ? `Połączono P2P (${connectedAddresses.length} ${connectedAddresses.length === 1 ? 'urządzenie' : 'urządzeń'})`
              : 'Brak połączonych urządzeń P2P'}
          </span>
        </div>

        <div className="px-6 mt-6 mb-2 text-xs font-bold uppercase tracking-widest text-red-500">
          Tryb Ratunkowy
        </div>
        <motion.div
          whileTap={{ scale: 0.98 }}
          className="flex items-center px-6 py-4 mx-4 mb-4 bg-red-500/10 border border-red-500/20 rounded-2xl cursor-pointer hover:bg-red-500/20 transition-colors"
          onClick={() => setShowSos(true)}
        >
          <div className="w-12 h-12 rounded-full bg-red-500/20 text-red-500 flex items-center justify-center flex-shrink-0 animate-pulse">
            <AlertTriangle size={24} />
          </div>
          <div className="flex-1 ml-4 flex flex-col">
            <span className="text-lg font-bold text-red-500">Nadaj sygnał SOS</span>
            <span className="text-sm text-red-500/80">
              Rozgłasza do wszystkich w zasięgu (32 skoki)
            </span>
          </div>
        </motion.div>

        <div className="px-6 pt-6 pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
          O aplikacji
        </div>
        <div className="flex items-center px-6 py-4 mb-4">
          <div className="w-10 h-10 rounded-full bg-accent/10 text-accent flex items-center justify-center flex-shrink-0">
            <Info size={20} />
          </div>
          <div className="flex-1 ml-4 flex flex-col">
            <span className="text-base font-semibold text-foreground">O Void</span>
            <span className="text-sm text-muted-foreground">System łączności rozproszonej</span>
            <span className="text-xs text-emerald-500 font-medium mt-1">Auto-updater aktywny ✅</span>
          </div>
          <span className="text-sm font-medium text-muted-foreground bg-secondary px-2.5 py-1 rounded-md">v{appVersion || '...'}</span>
        </div>

        <div className="h-px bg-border/50 mx-6 my-4" />

        <div className="px-6 pt-2 pb-2 text-xs font-bold uppercase tracking-widest text-red-500/80">
          Strefa zagrożenia
        </div>

        <motion.div
          whileTap={{ scale: 0.98 }}
          className="flex items-center px-6 py-4 mx-4 mb-8 bg-red-500/10 border border-red-500/20 rounded-2xl cursor-pointer hover:bg-red-500/20 transition-colors"
          onClick={handlePanic}
          role="button"
          tabIndex={0}
        >
          <div className="w-10 h-10 rounded-full bg-red-500/20 text-red-500 flex items-center justify-center flex-shrink-0">
            <ShieldAlert size={20} />
          </div>
          <div className="flex-1 ml-4 flex flex-col">
            <span className="text-base font-bold text-red-500">Czyszczenie protokołu E2EE</span>
            <span className="text-sm text-red-500/80">
              Usuń klucze szyfrowania
            </span>
          </div>
        </motion.div>
      </div>

      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-0 z-40 bg-background flex flex-col h-full"
          >
            <div className="flex items-center gap-3 px-4 py-3 pt-safe bg-background border-b border-border/50 sticky top-0 z-10">
              <button 
                className="p-2 -ml-2 rounded-full text-accent hover:bg-secondary transition-colors" 
                onClick={() => setShowSettings(false)} 
              >
                <ChevronLeft size={28} strokeWidth={2.5} />
              </button>
              <h2 className="text-xl font-bold text-foreground">Ustawienia</h2>
            </div>
            
            <div className="flex-1 overflow-y-auto pb-safe no-scrollbar">
              
              <div className="px-6 pt-6 pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Profil Użytkownika
              </div>
              <div className="px-6 py-4 border-b border-border/10 flex flex-col gap-4">
                {editProfile ? (
                  <div className="flex flex-col gap-3">
                    <input
      type="text"
      value={tempName}
      onChange={(e) => setTempName(e.target.value)}
      placeholder="Nazwa wyświetlana"
      maxLength={80}
      className="w-full bg-secondary text-foreground rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-accent"
    />
    <div className="flex flex-col gap-2 mt-2">
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest ml-1">Wybierz Awatar</span>
      <div className="grid grid-cols-6 gap-2">
        {['👽', '🤖', '👻', '🐱', '🦊', '🐻', '🐼', '🦁', '🐯', '🐰', '😎', '🤠'].map((emoji) => (
          <button
            key={emoji}
            onClick={() => setTempAvatar(emoji)}
            className={`w-10 h-10 rounded-full flex items-center justify-center text-xl transition-transform ${tempAvatar === emoji ? 'bg-accent text-white scale-110 shadow-lg shadow-accent/40' : 'bg-secondary hover:bg-secondary/80'}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => setEditProfile(false)}
                        className="flex-1 bg-secondary text-foreground rounded-xl py-2 font-semibold"
                      >
                        Anuluj
                      </button>
                      <button 
                        onClick={async () => {
                          const normalizedName = tempName.trim();
                          if (!normalizedName) return;
                          try {
                            await setNodeName(normalizedName);
                            updateProfile({ displayName: normalizedName, avatarLetter: tempAvatar });
                            setEditProfile(false);
                          } catch (error) {
                            window.alert(`Nie udało się zmienić nazwy węzła: ${String(error)}`);
                          }
                        }}
                        className="flex-1 bg-accent text-white rounded-xl py-2 font-semibold shadow-md"
                      >
                        Zapisz
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <Avatar name={profile.displayName || "Vortex User"} avatarLetter={profile.avatarLetter} size={48} online={true} />
                      <div className="flex flex-col">
                        <span className="text-lg font-bold text-foreground">{profile.displayName || "Vortex User"}</span>
                        <span className="text-xs text-muted-foreground font-mono bg-secondary/50 px-1.5 py-0.5 rounded w-fit mt-0.5">ID: {nodeId || "Brak"}</span>
   <div className="flex items-center gap-2 mt-1.5">
     {connected ? (
       <div className="flex items-end gap-[2px] h-3">
         <motion.div animate={{ height: [4, 6, 4] }} transition={{ repeat: Infinity, duration: 1.2 }} className="w-1 bg-emerald-500 rounded-sm" />
         <motion.div animate={{ height: [6, 10, 6] }} transition={{ repeat: Infinity, duration: 1.4, delay: 0.1 }} className="w-1 bg-emerald-500 rounded-sm" />
         <motion.div animate={{ height: [4, 12, 4] }} transition={{ repeat: Infinity, duration: 1.1, delay: 0.2 }} className="w-1 bg-emerald-500 rounded-sm" />
         <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 2 }} className="w-1 h-full bg-emerald-500 rounded-sm" />
       </div>
     ) : (
       <div className="flex items-end gap-[2px] h-3">
         <div className="w-1 h-1 bg-red-500 rounded-sm" />
         <div className="w-1 h-1 bg-red-500/30 rounded-sm" />
         <div className="w-1 h-1 bg-red-500/30 rounded-sm" />
         <div className="w-1 h-1 bg-red-500/30 rounded-sm" />
       </div>
     )}
     <span className={`text-xs font-semibold ${connected ? 'text-emerald-500' : 'text-red-500'}`}>
       {connected ? `Połączono (${connectedAddresses.length} GATT)` : meshError || 'Brak połączenia'}
     </span>
   </div>
                      </div>
                    </div>
                    <button 
                      onClick={() => {
                        setTempName(profile.displayName);
                        setTempAvatar(profile.avatarLetter || '');
                        setEditProfile(true);
                      }}
                      className="p-2 rounded-full bg-secondary/50 text-accent hover:bg-secondary transition-colors"
                    >
                      <Settings size={20} />
                    </button>
                  </div>
                )}
                
                {!editProfile && (
                                    <>
                  <div className="mt-4 flex flex-col items-center justify-center p-6 bg-white rounded-2xl">
                    <div className="text-center mb-3">
                      <span className="text-black font-bold text-sm">Zeskanuj mój profil</span>
                    </div>
                    {contactCard ? (
                       <QRCodeSVG value={contactCard} size={150} level="M" />
                    ) : (
                       <div className="w-[150px] h-[150px] flex items-center justify-center bg-gray-200 rounded-lg text-gray-500 text-xs text-center">Brak ID</div>
                    )}
                  </div>

                  <button
                    onClick={() => { setBackupError(''); setShowBackup(true); }}
                    className="mt-2 w-full bg-secondary/50 hover:bg-secondary text-foreground rounded-xl py-3 px-4 flex items-center justify-center gap-2 transition-colors border border-border/50"
                  >
                    <Key size={18} className="text-accent" />
                    <span className="font-semibold text-sm">Szyfrowana kopia tożsamości</span>
                    <Download size={16} className="text-muted-foreground ml-auto" />
                  </button>
                  </>
                )}
              </div>

              <div className="px-6 pt-6 pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Wygląd i Powiadomienia
              </div>
              
              {renderToggle(<Moon size={20} />, 'Motyw Aplikacji', theme === 'dark' ? 'Ciemny motyw' : 'Jasny motyw', theme === 'dark', toggleTheme)}
              {renderToggle(<Vibrate size={20} />, 'Wibracje', 'Wibracje przy nowej wiadomości', settings.vibrations, (val) => updateSetting('vibrations', val))}
              {renderToggle(<Volume2 size={20} />, 'Dźwięki', 'Odtwarzaj dźwięki powiadomień', settings.sounds, (val) => updateSetting('sounds', val))}
              {renderToggle(<Bell size={20} />, 'Powiadomienia SOS', 'Pokazuj systemowe powiadomienie dla sygnałów SOS', settings.criticalSos, (val) => updateSetting('criticalSos', val), true)}

              <div className="px-6 pt-6 pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Ustawienia Sieci Mesh (BLE)
              </div>

              <div className="flex items-center px-6 py-4 border-b border-border/10">
                <div className="w-10 h-10 rounded-full bg-accent/10 text-accent flex items-center justify-center flex-shrink-0">
                  <Radio size={20} />
                </div>
                <div className="flex-1 ml-4 flex flex-col pr-4">
                  <span className="text-base font-semibold text-foreground">Skoki BLE Mesh (Normalne)</span>
                  <span className="text-sm text-muted-foreground mt-0.5">Maksymalna liczba retransmisji</span>
                </div>
                <span className="text-lg font-bold text-accent bg-accent/10 px-3 py-1 rounded-lg">32</span>
              </div>

              <div className="flex items-center px-6 py-4 border-b border-border/10">
                <div className="w-10 h-10 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <div className="flex-1 ml-4 flex flex-col pr-4">
                  <span className="text-base font-semibold text-foreground">Skoki BLE Mesh (Tryb SOS)</span>
                  <span className="text-sm text-muted-foreground mt-0.5">Zwiększony zasięg dla alarmów</span>
                </div>
                <span className="text-lg font-bold text-red-500 bg-red-500/10 px-3 py-1 rounded-lg">32</span>
              </div>

              {renderToggle(<Radio size={20} />, 'Relay Node', 'Zezwalaj na retransmisję obcych wiadomości', settings.relayNode, (val) => updateSetting('relayNode', val))}
              {renderToggle(<Zap size={20} />, 'Oszczędzanie Baterii', 'Zmniejsza częstotliwość skanowania BLE', settings.batterySave, (val) => updateSetting('batterySave', val))}

              <div className="px-6 pt-6 pb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Prywatność i Bezpieczeństwo
              </div>

              <div className="flex items-center px-6 py-4 border-b border-border/10">
                <div className="w-10 h-10 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center"><Shield size={20} /></div>
                <div className="flex-1 ml-4">
                  <div className="font-semibold">E2EE wymagane</div>
                  <div className="text-sm text-muted-foreground">Niepodpisane i nieszyfrowane wiadomości są zawsze odrzucane</div>
                </div>
                <span className="text-xs font-bold text-emerald-500">ZAWSZE</span>
              </div>
              {renderToggle(<EyeOff size={20} />, 'Ukryty Węzeł', 'Nie pokazuj na liście publicznej', settings.hideNode, (val) => updateSetting('hideNode', val))}
              {renderToggle(<MessageSquareOff size={20} />, 'Anti-Spam', 'Automatycznie odrzucaj nowe czaty', settings.rejectNewChats, (val) => updateSetting('rejectNewChats', val))}
              {renderToggle(<Trash2 size={20} />, 'Auto-destrukcja', 'Usuwaj wiadomości po 24 godzinach', settings.autoDestruct, (val) => updateSetting('autoDestruct', val))}
              <div className="h-12" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showBackup && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              className="absolute inset-0 bg-background/80 backdrop-blur-sm"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => !backupBusy && setShowBackup(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-md bg-secondary rounded-3xl p-6 shadow-2xl border border-border max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3"><Key className="text-accent" /><h2 className="text-xl font-bold">Kopia tożsamości</h2></div>
                <button onClick={() => !backupBusy && setShowBackup(false)} aria-label="Zamknij"><X /></button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Plik zawiera klucze zaszyfrowane ChaCha20-Poly1305. Hasło jest wzmacniane przez PBKDF2-HMAC-SHA-256 i nigdy nie jest zapisywane.
              </p>
              <label className="text-xs font-bold uppercase text-muted-foreground">Hasło — minimum 12 znaków</label>
              <input
                type="password" value={backupPassword} onChange={event => setBackupPassword(event.target.value)}
                autoComplete="new-password" maxLength={256}
                className="mt-1 mb-3 w-full bg-background border border-border rounded-xl px-4 py-3"
              />
              <label className="text-xs font-bold uppercase text-muted-foreground">Powtórz hasło do eksportu</label>
              <input
                type="password" value={backupConfirmation} onChange={event => setBackupConfirmation(event.target.value)}
                autoComplete="new-password" maxLength={256}
                className="mt-1 mb-3 w-full bg-background border border-border rounded-xl px-4 py-3"
              />
              <button
                disabled={backupBusy}
                onClick={handleExportBackup}
                className="w-full bg-accent text-white rounded-xl py-3 font-bold flex items-center justify-center gap-2 disabled:opacity-50"
              ><Download size={18} />Eksportuj zaszyfrowany plik</button>

              <div className="h-px bg-border my-5" />
              <label className="text-xs font-bold uppercase text-muted-foreground">Importuj plik kopii</label>
              <input
                type="file" accept="application/json,.json"
                className="mt-2 mb-3 block w-full text-sm"
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 16 * 1024) { setBackupError('Plik kopii jest zbyt duży.'); return; }
                  file.text().then(setBackupImport).catch(error => setBackupError(String(error)));
                }}
              />
              <button
                disabled={backupBusy || !backupImport}
                onClick={handleImportBackup}
                className="w-full bg-red-500 text-white rounded-xl py-3 font-bold flex items-center justify-center gap-2 disabled:opacity-50"
              ><Upload size={18} />Importuj i zastąp tożsamość</button>
              {backupError && <p className="mt-3 text-sm text-red-500 break-words">{backupError}</p>}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSos && (
          <div className="absolute inset-0 z-50 flex items-end justify-center sm:items-center">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-background/80 backdrop-blur-sm"
              onClick={() => setShowSos(false)}
            />
            
            <motion.div 
              initial={{ opacity: 0, y: "100%" }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="relative w-full max-w-md bg-secondary/95 backdrop-blur-md rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl border border-border/50 flex flex-col gap-5 sm:m-4 max-h-[90vh] overflow-y-auto no-scrollbar"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-red-500 flex items-center justify-center shadow-lg shadow-red-500/30">
                    <AlertTriangle size={24} className="text-white" />
                  </div>
                  <h2 className="text-2xl font-bold text-foreground">Sygnał SOS</h2>
                </div>
                <button 
                  className="p-2 rounded-full bg-background/50 hover:bg-background text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowSos(false)}
                >
                  <X size={20} />
                </button>
              </div>

              <div className="text-sm text-muted-foreground leading-relaxed">
                Nadanie sygnału SOS wykorzysta maksymalną moc sieci Mesh (32 skoki), omijając filtry, by dotrzeć do wszystkich w promieniu kilku kilometrów. Używaj tylko w razie zagrożenia.
              </div>

              <div className="flex flex-col gap-4 mt-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground ml-1">Twoje Imię / Identyfikator</label>
                  <input 
                    type="text" 
                    value={sosName}
                    onChange={(e) => setSosName(e.target.value.slice(0, 80))}
                    maxLength={80}
                    placeholder="np. Jan Kowalski"
                    className="w-full bg-background border border-border/50 rounded-xl px-4 py-3 text-foreground outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all"
                  />
                </div>
                
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground ml-1">Krótki opis sytuacji (max 200 znaków)</label>
                  <textarea 
                    value={sosDesc}
                    onChange={(e) => setSosDesc(e.target.value.slice(0, 200))}
                    placeholder="Co się dzieje? Jakiej pomocy potrzebujesz?"
                    className="w-full bg-background border border-border/50 rounded-xl px-4 py-3 text-foreground outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all resize-none min-h-[100px]"
                  />
                  <div className="text-right text-xs text-muted-foreground">
                    {sosDesc.length}/200
                  </div>
                </div>

                <div className="flex items-center gap-3 p-3 bg-background/50 rounded-xl border border-border/50">
                  <div className="p-2 bg-accent/10 text-accent rounded-lg">
                    <MapPin size={20} />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-foreground">Lokalizacja GPS</span>
                    <span className="text-xs text-muted-foreground">Opcjonalna — SOS zadziała również bez GPS</span>
                  </div>
                </div>
              </div>

              <button
                className={`mt-2 w-full py-4 rounded-xl flex items-center justify-center gap-2 font-bold text-white transition-all ${(!sosName.trim() || !sosDesc.trim() || sendingSos) ? 'bg-red-500/50 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/25 active:scale-[0.98]'}`}
                onClick={handleSendSos}
                disabled={!sosName.trim() || !sosDesc.trim() || sendingSos}
              >
                {sendingSos ? (
                  <span className="animate-pulse">Nadawanie w toku...</span>
                ) : (
                  <>
                    <Send size={20} />
                    NADAJ SOS W SIECI MESH
                  </>
                )}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MenuScreen;

