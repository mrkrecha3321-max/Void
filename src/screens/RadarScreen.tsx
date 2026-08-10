import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Radio, MapPin, Zap } from 'lucide-react';
import type { Peer } from '../types';
import Avatar from '../components/Avatar';

interface Props {
  peers: Peer[];
  onStartChat: (peerId: string, peerName: string) => void;
}

/**
 * Log-distance Path Loss Model:
 * d = 10 ^ ((MeasuredPower - RSSI) / (10 * n))
 * MeasuredPower = -59 dBm (1 meter calibration)
 * n = 2.0 (Path Loss exponent)
 */
export const calculateDistance = (
  rssi?: number,
  measuredPower: number = -59,
  n: number = 2.0
): number => {
  if (rssi === undefined || rssi === null || rssi === 0) {
    return 5.0; // Default distance if RSSI unavailable
  }
  const ratio = (measuredPower - rssi) / (10 * n);
  const distance = Math.pow(10, ratio);
  return Math.max(0.1, Math.round(distance * 10) / 10);
};

const RadarScreen: React.FC<Props> = ({ peers, onStartChat }) => {
  const [scanning, setScanning] = useState(true);
  
  // Widoczni ludzie posortowani po odległości
  const visiblePeers = peers
    .filter(p => p.online)
    .map(p => ({ ...p, distance: calculateDistance(p.rssi) }))
    .sort((a, b) => a.distance - b.distance);

  return (
    <div className="flex-1 flex flex-col pt-safe bg-background text-foreground h-full overflow-hidden relative">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0 bg-background/80 backdrop-blur-md z-10">
        <h1 className="text-2xl font-bold tracking-tight">Radar BLE</h1>
        <button 
          onClick={() => setScanning(!scanning)}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${scanning ? 'bg-accent/20 text-accent' : 'bg-secondary text-muted-foreground'}`}
        >
          <Radio size={20} className={scanning ? 'animate-pulse' : ''} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto relative z-0 flex flex-col">
        {/* Radar Animation Area */}
        <div className="relative w-full h-64 flex items-center justify-center shrink-0 border-b border-border/30 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent pointer-events-none" />
          
          <div className="relative w-40 h-40 flex items-center justify-center">
            {scanning && (
              <>
                <motion.div 
                  initial={{ scale: 0.8, opacity: 0.8 }}
                  animate={{ scale: 3, opacity: 0 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  className="absolute inset-0 rounded-full border-2 border-accent"
                />
                <motion.div 
                  initial={{ scale: 0.8, opacity: 0.8 }}
                  animate={{ scale: 3, opacity: 0 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear", delay: 1 }}
                  className="absolute inset-0 rounded-full border-2 border-accent/50"
                />
              </>
            )}
            
            <div className="w-16 h-16 bg-accent rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(var(--accent),0.5)] z-10">
              <Zap size={32} className="text-accent-foreground" />
            </div>
          </div>
        </div>

        <div className="flex-1 px-4 py-4 space-y-4">
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground px-2">
            Zasięg bezprzewodowy ({visiblePeers.length})
          </div>

          <AnimatePresence>
            {visiblePeers.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center p-8 text-muted-foreground flex flex-col items-center gap-3"
              >
                <MapPin size={40} className="opacity-20" />
                <p>Nie wykryto w pobliżu żadnych urządzeń sieci Mesh.</p>
              </motion.div>
            ) : (
              visiblePeers.map((peer, idx) => (
                <motion.div
                  key={peer.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="bg-secondary rounded-2xl p-4 flex items-center gap-4 cursor-pointer hover:bg-secondary/80 active:scale-[0.98] transition-all"
                  onClick={() => onStartChat(peer.id, peer.name)}
                >
                  <Avatar name={peer.name} size={48} />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center mb-1">
                      <h3 className="font-semibold text-base truncate pr-2">{peer.name}</h3>
                      <span className="text-xs font-bold text-accent px-2 py-1 bg-accent/10 rounded-full shrink-0">
                        ~{peer.distance}m
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate opacity-70">
                      ID: {peer.id.slice(0, 8).toUpperCase()}
                    </p>
                  </div>
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default RadarScreen;
