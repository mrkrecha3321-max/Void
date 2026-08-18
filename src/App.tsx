import { useState, useEffect } from "react";
import {
  checkForUpdates,
  installUpdate,
  onMessageReceived,
  onSosReceived,
  trustPeer,
} from "./api";
import { getVersion } from "@tauri-apps/api/app";
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { motion, AnimatePresence } from "motion/react";
import { AlertTriangle, MapPin, X, MoreVertical } from "lucide-react";
import BottomNav from "./components/BottomNav";
import ChatList from "./screens/ChatList";
import ChatView from "./screens/ChatView";
import Contacts from "./screens/Contacts";
import MenuScreen from "./screens/MenuScreen";
import RadarScreen from "./screens/RadarScreen";
import { useTheme } from "./hooks/useTheme";
import { useMesh } from "./hooks/useMesh";
import { useChats } from "./hooks/useChats";

type Tab = "chats" | "radar" | "contacts" | "menu";

interface ActiveChat {
  chatId: string;
  peerName: string;
}

interface IncomingSos {
  name: string;
  desc: string;
  location: string;
  distance: string;
}

const parseVersion = (value: string): [number, number, number] | null => {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number) as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
};

function App() {
  const { theme, toggleTheme } = useTheme();
  const { peers, connected, connectedAddresses, nodeId, error: meshError, addPeer } = useMesh();
  const { chats, messages, sendMessage, startChat, markRead, clearAllData } = useChats();

  const [activeTab, setActiveTab] = useState<Tab>("chats");
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [incomingSos, setIncomingSos] = useState<IncomingSos | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    isPermissionGranted()
      .then(granted => granted ? undefined : requestPermission())
      .catch(error => console.warn('Nie udało się sprawdzić uprawnień powiadomień:', error));
  }, []);

  useEffect(() => {
    const subscription = onMessageReceived((payload) => {
      try {
        const preferences = JSON.parse(localStorage.getItem('vortex-settings') || '{}') as {
          sounds?: boolean;
          vibrations?: boolean;
        };
        if (preferences.vibrations !== false) navigator.vibrate?.(120);
        if (preferences.sounds !== false) {
          sendNotification({ title: `Wiadomość od ${payload.peerId.slice(0, 11)}…`, body: payload.text });
        }
      } catch {
        // A malformed preference must not block message delivery.
      }
    });
    return () => { subscription.then(unlisten => unlisten?.()); };
  }, []);

  useEffect(() => {
    let mounted = true;
    const subscription = onSosReceived((payload) => {
      if (!mounted) return;
      const coordinates = payload.lat !== undefined && payload.lon !== undefined
        ? `${payload.lat.toFixed(5)}, ${payload.lon.toFixed(5)}`
        : "Brak dołączonej lokalizacji";
      setIncomingSos({
        name: payload.name,
        desc: payload.description,
        location: coordinates,
        distance: `ID: ${payload.senderId.slice(0, 11)}…`,
      });
      try {
        const preferences = JSON.parse(localStorage.getItem('vortex-settings') || '{}') as {
          criticalSos?: boolean;
          vibrations?: boolean;
        };
        if (preferences.vibrations !== false) navigator.vibrate?.([250, 100, 250, 100, 500]);
        if (preferences.criticalSos !== false) {
          sendNotification({
            title: `SOS — ${payload.name}`,
            body: payload.description,
          });
        }
      } catch {
        // The in-app SOS banner remains visible even with malformed preferences.
      }
    });
    return () => {
      mounted = false;
      subscription.then(unlisten => unlisten?.());
    };
  }, []);

  useEffect(() => {
    const checkVer = async () => {
      try {
        const ver = await checkForUpdates();
        if (!ver) return;
        
        const currentVer = await getVersion();
        
        const serverParts = parseVersion(ver);
        const currentParts = parseVersion(currentVer);
        if (!serverParts || !currentParts) {
          console.warn('Odrzucono nieprawidłową wersję release:', ver);
          return;
        }

        let isNewer = false;
        for (let index = 0; index < 3; index++) {
          if (serverParts[index] > currentParts[index]) {
            isNewer = true;
            break;
          }
          if (serverParts[index] < currentParts[index]) break;
        }
        
        if (isNewer) {
          setUpdateVersion(ver);
          
          let permissionGranted = await isPermissionGranted();
          if (!permissionGranted) {
            const permission = await requestPermission();
            permissionGranted = permission === 'granted';
          }
          if (permissionGranted) {
            sendNotification({ 
              title: 'Void - Nowa Wersja', 
              body: `Wersja ${ver} jest gotowa do pobrania! Otwórz aplikację by zainstalować.` 
            });
          }
        }
      } catch (err) {
        console.error(err);
      }
    };
    checkVer();
  }, []);

  const handleUpdate = async () => {
    if (!updateVersion) return;
    setIsUpdating(true);
    try {
      await installUpdate(updateVersion);
    } catch (err) {
      alert(`Błąd podczas pobierania aktualizacji: ${String(err)}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleOpenChat = (chatId: string, peerName: string) => {
    markRead(chatId);
    setActiveChat({ chatId, peerName });
  };

  const handleBackFromChat = () => {
    setActiveChat(null);
  };

  const handleStartChat = (peerId: string, peerName: string) => {
    if (/^VX-[0-9A-F]{32}$/i.test(peerId) && (window as any)['__TAURI_INTERNALS__']) {
      void trustPeer(peerId).catch(error => console.warn('Nie udało się oznaczyć peera jako zaufanego:', error));
    }
    const chatId = startChat(peerId, peerName);
    markRead(chatId);
    setActiveTab("chats");
    setActiveChat({ chatId, peerName });
  };

  const renderLeftPanelContent = () => {
    switch (activeTab) {
      case "chats":
        return <ChatList chats={chats} onOpenChat={handleOpenChat} />;
      case "radar":
        return <RadarScreen peers={peers} onStartChat={handleStartChat} />;
      case "contacts":
        return (
          <Contacts
            peers={peers}
            onStartChat={handleStartChat}
            onAddPeer={addPeer}
            myNodeId={nodeId}
          />
        );
      case "menu":
        return (
          <MenuScreen
            theme={theme}
            toggleTheme={toggleTheme}
            connected={connected}
            connectedAddresses={connectedAddresses}
            nodeId={nodeId}
            meshError={meshError}
            onPanic={() => {
              clearAllData();
              setActiveChat(null);
            }}
          />
        );
      default:
        return <ChatList chats={chats} onOpenChat={handleOpenChat} />;
    }
  };

  return (
    <div
      className={`flex flex-col h-screen h-screen-safe w-full relative overflow-hidden bg-background text-foreground ${theme === "dark" ? "dark" : ""}`}
    >
      {updateVersion && (
        <div className="bg-blue-600 text-white px-4 py-3 flex justify-between items-center z-[110] text-sm font-medium border-b border-black/10">
          <span>
            Nowa wersja <strong>{updateVersion}</strong> jest dostępna!
          </span>
          <button
            className="bg-white text-blue-600 border-none px-3 py-1.5 rounded-md font-bold cursor-pointer hover:bg-gray-100 transition-colors"
            onClick={handleUpdate}
            disabled={isUpdating}
          >
            {isUpdating ? "Pobieranie..." : "Aktualizuj"}
          </button>
        </div>
      )}

      {/* Incoming SOS Banner Overlay */}
      <AnimatePresence>
        {incomingSos && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="absolute top-0 inset-x-0 z-[100] p-4 pt-safe pointer-events-none"
          >
            <div className="bg-red-500 text-white rounded-2xl shadow-2xl p-4 flex flex-col gap-3 pointer-events-auto border-2 border-red-400 max-w-md mx-auto">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center animate-pulse">
                    <AlertTriangle size={24} />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-bold text-lg leading-none uppercase tracking-wide text-white">
                      Sygnał SOS
                    </span>
                    <span className="text-xs text-white/80 mt-0.5">
                      {incomingSos.name}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setIncomingSos(null)}
                  className="p-2 bg-black/10 rounded-full hover:bg-black/20 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="bg-black/10 rounded-xl p-3 text-sm font-medium leading-relaxed">
                "{incomingSos.desc}"
              </div>
              <div className="flex items-center gap-2 text-xs font-semibold bg-white/10 p-2.5 rounded-xl">
                <MapPin size={16} />
                <span>{incomingSos.location}</span>
                <span className="opacity-70 ml-auto">
                  {incomingSos.distance}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="flex-1 flex overflow-hidden relative">
        {/* Left Sidebar (Desktop: visible always, Mobile: visible if no active chat) */}
        <div 
          className={`flex-shrink-0 w-full md:w-[360px] lg:w-[400px] flex flex-col border-r border-border/10 bg-background transition-transform
          ${activeChat ? 'hidden md:flex' : 'flex'}
        `}>
          {/* Main List Area */}
          <div className="flex-1 overflow-hidden relative flex flex-col">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                transition={{ duration: 0.15 }}
                className="flex-1 flex flex-col absolute inset-0"
              >
                {renderLeftPanelContent()}
              </motion.div>
            </AnimatePresence>
          </div>
          
          {/* Mobile Bottom Nav */}
          <div className="md:hidden">
            <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />
          </div>
        </div>

        {/* Right Column (Desktop: visible always, Mobile: visible if active chat) */}
        <div 
          className={`flex-1 flex flex-col relative bg-background/50
          ${!activeChat ? 'hidden md:flex' : 'flex'}
        `}>
          {/* Top Global Bar for Desktop when no chat is open, or combined in ChatView header */}
          {!activeChat && (
             <div className="h-16 border-b border-border/10 flex items-center justify-end px-4 bg-background">
                <button 
                  onClick={() => setShowSettings(true)}
                  className="p-2 rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                  aria-label="Ustawienia"
                >
                  <MoreVertical size={24} />
                </button>
             </div>
          )}

          {activeChat ? (
            <ChatView
              chatId={activeChat.chatId}
              chatName={activeChat.peerName}
              messages={messages[activeChat.chatId] || []}
              onBack={handleBackFromChat}
              onSend={sendMessage}
              onOpenSettings={() => setShowSettings(true)}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center opacity-60">
              <div className="w-24 h-24 bg-secondary/50 rounded-full flex items-center justify-center mb-6">
                <span className="text-4xl opacity-50">👋</span>
              </div>
              <h2 className="text-xl font-bold text-foreground">Wybierz rozmowę</h2>
              <p className="text-muted-foreground text-sm mt-2">Wybierz kontakt z listy, aby rozpocząć bezpieczny czat.</p>
            </div>
          )}
        </div>
      </main>

      {/* Desktop Settings Modal / Drawer (Reusing MenuScreen logic) */}
      <AnimatePresence>
        {showSettings && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm z-[120]"
              onClick={() => setShowSettings(false)}
            />
            <motion.div
              initial={{ opacity: 0, x: "100%", scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: "100%", scale: 0.95 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="absolute top-0 right-0 bottom-0 w-full max-w-md bg-background z-[130] shadow-2xl border-l border-border/10 flex flex-col"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-border/10 bg-secondary/30">
                <h2 className="text-xl font-bold text-foreground">Ustawienia</h2>
                <button 
                  className="p-2 rounded-full hover:bg-background transition-colors text-muted-foreground"
                  onClick={() => setShowSettings(false)}
                >
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto relative no-scrollbar">
                <MenuScreen
                  theme={theme}
                  toggleTheme={toggleTheme}
                  connected={connected}
                  connectedAddresses={connectedAddresses}
                  nodeId={nodeId}
                  meshError={meshError}
                  onPanic={() => {
                    clearAllData();
                    setActiveChat(null);
                    setShowSettings(false);
                  }}
                />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;
