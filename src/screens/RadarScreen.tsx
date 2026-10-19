import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Radio, MapPin, Zap, Compass, Download, Map as MapIcon, Navigation } from 'lucide-react';
import type { Peer } from '../types';
import { isPeerVisibleOnRadar, radarPeerLinkLabel } from '../peerLink';
import Avatar from '../components/Avatar';
import { getCurrentPosition, checkPermissions, requestPermissions } from '@tauri-apps/plugin-geolocation';
import { bleStartScanning, bleStopScanning, meshSendLocation } from '../api';
import { useSettings } from '../hooks/useSettings';

interface Props {
  peers: Peer[];
  onStartChat: (peerId: string, peerName: string) => void;
}

interface BreadcrumbPoint {
  lat: number;
  lon: number;
  ts: number;
}

export const calculateDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number => {
  const R = 6371e3;
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

export const calculateBearing = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number => {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
};

export const calculateDistanceRssi = (
  rssi?: number,
  measuredPower: number = -59,
  n: number = 2.0
): number => {
  if (rssi === undefined || rssi === null || rssi === 0) {
    return 5.0;
  }
  const ratio = (measuredPower - rssi) / (10 * n);
  const distance = Math.pow(10, ratio);
  return Math.max(0.1, Math.round(distance * 10) / 10);
};

const cardinalFromHeading = (deg: number): string => {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
};

const latLonToTile = (lat: number, lon: number, zoom: number): { x: number; y: number } => {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
};

const LOCATION_RECIPIENTS_KEY = 'vortex-location-recipients';
const BREADCRUMBS_KEY = 'vortex-breadcrumbs-v1';
const OSM_CACHE_NAME = 'void-osm-tiles-v1';

const loadLocationRecipients = (): Set<string> => {
  try {
    const raw = localStorage.getItem(LOCATION_RECIPIENTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === 'string' && /^VX-[0-9A-F]{32}$/i.test(item))
    );
  } catch {
    return new Set();
  }
};

const loadBreadcrumbs = (): BreadcrumbPoint[] => {
  try {
    const raw = localStorage.getItem(BREADCRUMBS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-50);
  } catch {
    return [];
  }
};

const RadarScreen: React.FC<Props> = ({ peers, onStartChat }) => {
  const [scanning, setScanning] = useState(true);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [radarNow, setRadarNow] = useState(() => Date.now());
  const { settings, updateSetting } = useSettings();
  const sharingLocation = settings.locationSharing;
  const [myLat, setMyLat] = useState<number | null>(null);
  const [myLon, setMyLon] = useState<number | null>(null);
  const [heading, setHeading] = useState<number>(0);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbPoint[]>(loadBreadcrumbs);
  const [viewMode, setViewMode] = useState<'radar' | 'map'>('radar');
  const [cachingTiles, setCachingTiles] = useState(false);
  const [cachedTileCount, setCachedTileCount] = useState<number>(0);
  const [tileStatus, setTileStatus] = useState<string | null>(null);
  const [locationRecipients, setLocationRecipients] = useState<Set<string>>(loadLocationRecipients);

  useEffect(() => {
    try {
      localStorage.setItem(LOCATION_RECIPIENTS_KEY, JSON.stringify(Array.from(locationRecipients)));
    } catch {
    }
  }, [locationRecipients]);

  useEffect(() => {
    const onOrientation = (event: DeviceOrientationEvent) => {
      const webkitCompass = (event as any).webkitCompassHeading;
      if (typeof webkitCompass === 'number' && Number.isFinite(webkitCompass)) {
        setHeading(Math.round(webkitCompass));
      } else if (typeof event.alpha === 'number' && Number.isFinite(event.alpha)) {
        setHeading(Math.round((360 - event.alpha) % 360));
      }
    };
    window.addEventListener('deviceorientation', onOrientation, true);
    return () => window.removeEventListener('deviceorientation', onOrientation, true);
  }, []);

  useEffect(() => {
    if (typeof caches === 'undefined') return;
    caches.open(OSM_CACHE_NAME)
      .then(cache => cache.keys())
      .then(keys => setCachedTileCount(keys.length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!(window as any)['__TAURI_INTERNALS__']) return;
    let mounted = true;
    setScanBusy(true);
    bleStartScanning()
      .then(started => {
        if (!mounted) return;
        setScanning(started);
        setScanError(started ? null : 'Nie udało się uruchomić skanowania Bluetooth.');
      })
      .catch(error => {
        if (!mounted) return;
        setScanning(false);
        setScanError(String(error));
      })
      .finally(() => {
        if (mounted) setScanBusy(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!scanning) return;
    setRadarNow(Date.now());
    const interval = setInterval(() => setRadarNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [scanning]);

  const toggleScanning = async () => {
    if (scanBusy) return;
    if (!(window as any)['__TAURI_INTERNALS__']) {
      setScanning(current => !current);
      return;
    }
    setScanBusy(true);
    setScanError(null);
    try {
      if (scanning) {
        await bleStopScanning();
        setScanning(false);
      } else {
        const started = await bleStartScanning();
        if (!started) throw new Error('Nie udało się uruchomić skanowania Bluetooth.');
        setRadarNow(Date.now());
        setScanning(true);
      }
    } catch (error) {
      setScanError(String(error));
    } finally {
      setScanBusy(false);
    }
  };

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    let active = true;

    const setupLocation = async () => {
      try {
        let perms = await checkPermissions();
        if (perms.location !== 'granted') {
          perms = await requestPermissions(['location', 'coarseLocation']);
          if (perms.location !== 'granted' && perms.coarseLocation !== 'granted') return;
        }

        const fetchLoc = async () => {
          if (!active) return;
          try {
            const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
            if (pos && pos.coords) {
              const lat = pos.coords.latitude;
              const lon = pos.coords.longitude;
              setMyLat(lat);
              setMyLon(lon);
              setBreadcrumbs(prev => {
                const last = prev[prev.length - 1];
                if (last && calculateDistance(last.lat, last.lon, lat, lon) < 5) {
                  return prev;
                }
                const next = [...prev.slice(-49), { lat, lon, ts: Date.now() }];
                try {
                  localStorage.setItem(BREADCRUMBS_KEY, JSON.stringify(next));
                } catch {
                }
                return next;
              });

              if (sharingLocation) {
                peers.filter(peer =>
                  peer.online && /^VX-[0-9A-F]{32}$/i.test(peer.id) && locationRecipients.has(peer.id)
                ).forEach(peer => {
                  meshSendLocation(peer.id, lat, lon).catch((error) => {
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

    if (scanning && (sharingLocation || viewMode === 'map')) {
      setupLocation();
    }

    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [scanning, sharingLocation, viewMode, peers, locationRecipients]);

  const handleDownloadOfflineTiles = async () => {
    if (cachingTiles) return;
    const centerLat = myLat ?? 52.2297;
    const centerLon = myLon ?? 21.0122;
    setCachingTiles(true);
    setTileStatus('Pobieranie kafelków OSM (promień 5 km)...');
    try {
      const cache = await caches.open(OSM_CACHE_NAME);
      const urls: string[] = [];
      for (const zoom of [13, 14]) {
        const center = latLonToTile(centerLat, centerLon, zoom);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            urls.push(`https://tile.openstreetmap.org/${zoom}/${center.x + dx}/${center.y + dy}.png`);
          }
        }
      }
      let fetchedCount = 0;
      for (const url of urls) {
        try {
          const response = await fetch(url, { mode: 'cors' });
          if (response.ok) {
            await cache.put(url, response.clone());
            fetchedCount++;
          }
        } catch {
        }
      }
      const allKeys = await cache.keys();
      setCachedTileCount(allKeys.length);
      setTileStatus(
        fetchedCount > 0
          ? `Zapisano ${fetchedCount} kafelków offline (łącznie w pamięci: ${allKeys.length})`
          : `Tryb offline — w pamięci podręcznej: ${allKeys.length} kafelków`
      );
    } catch (err) {
      setTileStatus(`Błąd pamięci podręcznej mapy: ${String(err)}`);
    } finally {
      setCachingTiles(false);
    }
  };

  const visiblePeers = peers
    .filter(p => scanning && isPeerVisibleOnRadar(p, radarNow))
    .map(p => {
      if (myLat !== null && myLon !== null && p.lat !== undefined && p.lon !== undefined) {
        return {
          ...p,
          distance: calculateDistance(myLat, myLon, p.lat, p.lon),
          bearing: calculateBearing(myLat, myLon, p.lat, p.lon),
          method: 'gps' as const,
        };
      }
      return {
        ...p,
        distance: calculateDistanceRssi(p.rssi),
        bearing: undefined,
        method: 'rssi' as const,
      };
    })
    .sort((a, b) => a.distance - b.distance);

  const centerTile = latLonToTile(myLat ?? 52.2297, myLon ?? 21.0122, 14);

  return (
    <div className="flex-1 flex flex-col pt-safe bg-background text-foreground h-full overflow-hidden relative">
      <header className="flex items-center justify-between px-5 py-3.5 border-b border-border/50 shrink-0 bg-background/80 backdrop-blur-md z-10">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">Radar BLE</h1>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-accent text-xs font-mono font-bold">
            <Compass size={12} />
            {heading}° {cardinalFromHeading(heading)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setViewMode(m => (m === 'radar' ? 'map' : 'radar'))}
            className={`h-9 px-2.5 rounded-full flex items-center gap-1.5 text-xs font-bold transition-colors ${
              viewMode === 'map' ? 'bg-accent text-white' : 'bg-secondary text-muted-foreground'
            }`}
            title="Przełącz widok: Radar Wektorowy / Mapa Taktyczna Offline"
          >
            <MapIcon size={14} />
            {viewMode === 'map' ? 'Mapa' : 'Siatka'}
          </button>
          <button
            onClick={() => updateSetting('locationSharing', !sharingLocation)}
            className={`h-9 px-2.5 rounded-full flex items-center gap-1.5 text-xs font-semibold transition-colors ${sharingLocation ? 'bg-blue-500/20 text-blue-500' : 'bg-secondary text-muted-foreground'}`}
            aria-pressed={sharingLocation}
            title="Udostępnianie lokalizacji peerom"
          >
            <MapPin size={14} />
            {sharingLocation ? `GPS (${locationRecipients.size})` : 'GPS Wył.'}
          </button>
          <button
            onClick={toggleScanning}
            disabled={scanBusy}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${scanning ? 'bg-accent/20 text-accent' : 'bg-secondary text-muted-foreground'}`}
            aria-label={scanning ? 'Zatrzymaj radar' : 'Uruchom radar'}
          >
            <Radio size={18} className={scanning || scanBusy ? 'animate-pulse' : ''} />
          </button>
        </div>
      </header>

      {scanError && (
        <div className="px-6 py-2 text-xs text-red-500 border-b border-red-500/20">
          {scanError}
        </div>
      )}

      <div className="flex-1 overflow-y-auto relative z-0 flex flex-col">
        {viewMode === 'radar' ? (
          <div className="relative w-full h-64 flex items-center justify-center shrink-0 border-b border-border/30 overflow-hidden bg-secondary/20">
            <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent pointer-events-none" />

            {/* Tactical Azimuth Ring & Breadcrumb Trail */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-40" viewBox="0 0 240 240">
              <circle cx="120" cy="120" r="45" fill="none" stroke="currentColor" strokeDasharray="3 3" className="text-border" />
              <circle cx="120" cy="120" r="85" fill="none" stroke="currentColor" strokeDasharray="3 3" className="text-border" />
              <line x1="120" y1="15" x2="120" y2="225" stroke="currentColor" strokeWidth="0.5" className="text-border" />
              <line x1="15" y1="120" x2="225" y2="120" stroke="currentColor" strokeWidth="0.5" className="text-border" />
              {breadcrumbs.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2"
                  points={breadcrumbs
                    .map(pt => {
                      const base = breadcrumbs[breadcrumbs.length - 1];
                      const dx = Math.max(-90, Math.min(90, (pt.lon - base.lon) * 80000));
                      const dy = Math.max(-90, Math.min(90, (base.lat - pt.lat) * 80000));
                      return `${120 + dx},${120 + dy}`;
                    })
                    .join(' ')}
                />
              )}
            </svg>

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

            <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between text-[10px] font-mono text-muted-foreground">
              <span>Ślad GPS: {breadcrumbs.length}/50 pkt</span>
              <span>
                {myLat !== null && myLon !== null
                  ? `${myLat.toFixed(4)}°N, ${myLon.toFixed(4)}°E`
                  : 'Tryb pasywny RSSI'}
              </span>
            </div>
          </div>
        ) : (
          <div className="relative w-full h-72 flex flex-col shrink-0 border-b border-border/30 overflow-hidden bg-black">
            <div className="grid grid-cols-3 grid-rows-3 w-full h-full opacity-75">
              {[-1, 0, 1].map(dy =>
                [-1, 0, 1].map(dx => {
                  const tx = centerTile.x + dx;
                  const ty = centerTile.y + dy;
                  const url = `https://tile.openstreetmap.org/14/${tx}/${ty}.png`;
                  return (
                    <img
                      key={`${tx}-${ty}`}
                      src={url}
                      alt=""
                      className="w-full h-full object-cover filter invert hue-rotate-180 contrast-125"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.opacity = '0.15';
                      }}
                    />
                  );
                })
              )}
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-8 h-8 rounded-full bg-accent/30 border-2 border-accent flex items-center justify-center">
                <Navigation
                  size={16}
                  className="text-accent"
                  style={{ transform: `rotate(${heading}deg)` }}
                />
              </div>
            </div>
            <div className="absolute top-2.5 left-3 right-3 flex items-center justify-between gap-2">
              <span className="px-2.5 py-1 rounded-xl bg-black/75 border border-white/15 text-[11px] font-mono text-emerald-400">
                Cache OSM: {cachedTileCount} kafelków · Ślad: {breadcrumbs.length} pkt
              </span>
              <button
                type="button"
                disabled={cachingTiles}
                onClick={handleDownloadOfflineTiles}
                className="px-3 py-1.5 rounded-xl bg-accent text-white text-xs font-bold flex items-center gap-1.5 shadow-lg disabled:opacity-50"
              >
                <Download size={13} />
                {cachingTiles ? 'Pobieranie...' : 'Zapisz 5 km Offline'}
              </button>
            </div>
            {tileStatus && (
              <div className="absolute bottom-2 left-3 right-3 px-2.5 py-1 rounded-lg bg-black/80 text-[11px] text-white/90 font-mono truncate">
                {tileStatus}
              </div>
            )}
          </div>
        )}

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
                    <div className="flex justify-between items-center mb-1 gap-2">
                      <h3 className="font-semibold text-base truncate">{peer.name}</h3>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {peer.bearing !== undefined && (
                          <span className="text-[10px] font-mono font-bold px-2 py-1 rounded-full bg-secondary border border-border text-foreground">
                            {peer.bearing}° {cardinalFromHeading(peer.bearing)}
                          </span>
                        )}
                        <span className={`text-[10px] font-bold px-2 py-1 rounded-full shrink-0 ${peer.method === 'gps' ? 'bg-blue-500/10 text-blue-500' : 'bg-accent/10 text-accent'}`}>
                          {peer.method === 'gps' ? 'GPS' : 'BLE'} ~{peer.distance > 1000 ? (peer.distance / 1000).toFixed(1) + 'km' : peer.distance + 'm'}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground truncate opacity-70">
                      {radarPeerLinkLabel(peer, radarNow)} · ID: {peer.id.slice(0, 8).toUpperCase()}
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

