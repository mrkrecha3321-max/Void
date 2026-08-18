import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Radio, MapPin, Zap } from 'lucide-react';
import type { Peer } from '../types';
import { peerLinkLabel } from '../peerLink';
import Avatar from '../components/Avatar';
import { getCurrentPosition, checkPermissions, requestPermissions } from '@tauri-apps/plugin-geolocation';
import { meshSendLocation } from '../api';
import { useSettings } from '../hooks/useSettings';

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
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number => {
  const R = 6371e3; // Earth radius in metres
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distance = R * c;
  return Math.max(0.1, Math.round(distance * 10) / 10);
};

export const calculateDistanceRssi = (
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
  const { settings, updateSetting } = useSettings();
  const sharingLocation = settings.locationSharing;
  const [myLat, setMyLat] = useState<number | null>(null);
  const [myLon, setMyLon] = useState<number | null>(null);
  const [locationRecipients, setLocationRecipients] = useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    let active = true;

    const setupLocation = async () => {
      try {
        let perms = await checkPermissions();
        if (perms.location !== 'granted') {
          perms = await requestPermissions(['location', 'coarseLocation']);
          if (perms.location !== 'granted') return;
        }

        const fetchLoc = async () => {
          if (!active) return;
          try {
            const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
            if (pos && pos.coords) {
              setMyLat(pos.coords.latitude);
              setMyLon(pos.coords.longitude);

              // Location is shared only after an explicit user opt-in.
              if (sharingLocation) {
                peers.filter(peer =>
                  peer.online && /^VX-[0-9A-F]{32}$/i.test(peer.id) && locationRecipients.has(peer.id)
                ).forEach(peer => {
                  meshSendLocation(peer.id, pos.coords.latitude, pos.coords.longitude).catch((error) => {
                    console.warn(`Nie udało się udostępnić lokalizacji ${peer.id}:`, error);
                  });
                });
              }
            }
          } catch (e) {
            console.warn("Could not fetch location", e);
          }
        };

        fetchLoc();
        interval = setInterval(fetchLoc, 10000);
      } catch (err) {
        console.error('Geo error:', err);
      }
    };

    if (scanning) {
      setupLocation();
    }

    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [scanning, sharingLocation, peers, locationRecipients]);

  // Widoczni ludzie posortowani po odległości
  const visiblePeers = peers
    .filter(p => p.linkStatus === 'discovered' || p.linkStatus === 'connecting' || p.linkStatus === 'connected' || p.linkStatus === 'ready')
    .map(p => {
      if (myLat !== null && myLon !== null && p.lat !== undefined && p.lon !== undefined) {
        return { ...p, distance: calculateDistance(myLat, myLon, p.lat, p.lon), method: 'gps' };
      }
      return { ...p, distance: calculateDistanceRssi(p.rssi), method: 'rssi' };
    })
    .sort((a, b) => a.distance - b.distance);

  return (
    <div className="flex-1 flex flex-col pt-safe bg-background text-foreground h-full overflow-hidden relative">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0 bg-background/80 backdrop-blur-md z-10">
        <h1 className="text-2xl font-bold tracking-tight">Radar BLE</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => updateSetting('locationSharing', !sharingLocation)}
            className={`h-10 px-3 rounded-full flex items-center gap-2 text-xs font-semibold transition-colors ${sharingLocation ? 'bg-blue-500/20 text-blue-500' : 'bg-secondary text-muted-foreground'}`}
            aria-pressed={sharingLocation}
            title="Udostępnianie lokalizacji peerom"
          >
            <MapPin size={16} />
            {sharingLocation ? `GPS: ${locationRecipients.size} odb.` : 'GPS prywatny'}
          </button>
          <button
            onClick={() => setScanning(!scanning)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${scanning ? 'bg-accent/20 text-accent' : 'bg-secondary text-muted-foreground'}`}
            aria-label={scanning ? 'Zatrzymaj radar' : 'Uruchom radar'}
          >
            <Radio size={20} className={scanning ? 'animate-pulse' : ''} />
          </button>
        </div>
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
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full shrink-0 ${peer.method === 'gps' ? 'bg-blue-500/10 text-blue-500' : 'bg-accent/10 text-accent'}`}>
                        {peer.method === 'gps' ? 'GPS' : 'BLE'} ~{peer.distance > 1000 ? (peer.distance / 1000).toFixed(1) + 'km' : peer.distance + 'm'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate opacity-70">
                      {peerLinkLabel(peer.linkStatus, peer.online)} · ID: {peer.id.slice(0, 8).toUpperCase()}
                    </p>
                  </div>
                  {/^VX-[0-9A-F]{32}$/i.test(peer.id) && (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setLocationRecipients(previous => {
                          const next = new Set(previous);
                          if (next.has(peer.id)) next.delete(peer.id); else next.add(peer.id);
                          return next;
                        });
                      }}
                      aria-pressed={locationRecipients.has(peer.id)}
                      title="Zezwól temu kontaktowi na odbiór lokalizacji"
                      className={`w-9 h-9 rounded-full flex items-center justify-center ${locationRecipients.has(peer.id) ? 'bg-blue-500 text-white' : 'bg-background text-muted-foreground'}`}
                    >
                      <MapPin size={16} />
                    </button>
                  )}
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
