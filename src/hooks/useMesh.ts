import { useState, useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  startMesh,
  getPeers,
  getNodeId,
  addPeer as apiAddPeer,
  onPeerDiscovered,
  onPeerStatus,
  onBlePeerDiscovered,
  getConnectedAddresses,
  meshFlushOutbox,
  onBlePeerConnected,
  onBlePeerDisconnected,
  onPeerLocationReceived,
  onBleError,
  setNodeName,
  type BlePeerDiscovered,
} from '../api';
import type { Peer, PeerDiscoveredPayload, PeerStatusPayload, PeerLocationPayload } from '../types';

export function useMesh() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connectedAddresses, setConnectedAddresses] = useState<string[]>([]);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connected = connectedAddresses.length > 0;

  useEffect(() => {
    let isMounted = true;

    const discoveredPromise = onPeerDiscovered((payload: PeerDiscoveredPayload) => {
      setPeers(prev => {
        const existingIndex = prev.findIndex(
          p => p.id === payload.id || payload.id.endsWith(p.id) || p.id.endsWith(payload.id) || (p.address && payload.address && p.address === payload.address)
        );
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            id: payload.id,
            name: payload.name || updated[existingIndex].name,
            online: payload.online,
            ...(payload.rssi !== undefined ? { rssi: payload.rssi } : {}),
            ...(payload.address ? { address: payload.address } : {}),
          };
          return updated;
        } else {
          return [
            ...prev,
            {
              id: payload.id,
              name: payload.name || payload.id.slice(0, 8),
              online: payload.online,
              ...(payload.rssi !== undefined ? { rssi: payload.rssi } : {}),
              ...(payload.address ? { address: payload.address } : {}),
            },
          ];
        }
      });
    });

    const bleDiscoveredPromise = onBlePeerDiscovered((payload: BlePeerDiscovered) => {
      if (!isMounted) return;
      setPeers(prev => {
        const existingIndex = prev.findIndex(
          p => p.id === payload.shortId || p.id.endsWith(payload.shortId) || (p.address && p.address === payload.address)
        );
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            name: payload.name || updated[existingIndex].name,
            rssi: payload.rssi,
            address: payload.address,
            online: true,
          };
          return updated;
        } else {
          return [
            ...prev,
            {
              id: payload.shortId,
              name: payload.name || payload.shortId,
              online: true,
              rssi: payload.rssi,
              address: payload.address,
            },
          ];
        }
      });
    });

    const statusPromise = onPeerStatus((payload: PeerStatusPayload) => {
      setPeers(prev =>
        prev.map(p => (p.id === payload.id ? { ...p, online: payload.online } : p))
      );
    });

    const connectedAddressPromise = onBlePeerConnected((payload: { address: string }) => {
      if (!isMounted) return;
      setConnectedAddresses(prev => (prev.includes(payload.address) ? prev : [...prev, payload.address]));
    });

    const disconnectedAddressPromise = onBlePeerDisconnected((payload: { address: string }) => {
      if (!isMounted) return;
      setConnectedAddresses(prev => prev.filter(addr => addr !== payload.address));
      setPeers(prev => prev.map(peer =>
        peer.address === payload.address
          ? { ...peer, online: false, lastSeen: new Date().toISOString() }
          : peer
      ));
    });

    const bleErrorPromise = onBleError((payload) => {
      if (isMounted) setError(payload.message || 'Nieznany błąd BLE');
    });

    const permPromise = listen('ble_permissions_granted', () => {
      if (isMounted) {
        startMesh().then(() => setError(null)).catch((meshError) => {
          if (isMounted) setError(String(meshError));
        });
        getConnectedAddresses()
          .then(addrs => {
            if (isMounted && addrs) setConnectedAddresses(addrs);
          })
          .catch(() => {});
      }
    }).catch(() => undefined);

    const locationPromise = onPeerLocationReceived((payload: PeerLocationPayload) => {
      if (!isMounted) return;
      setPeers(prev => {
        const existingIndex = prev.findIndex(p => p.id === payload.peerId || p.id.endsWith(payload.peerId));
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            lat: payload.lat,
            lon: payload.lon,
          };
          return updated;
        }
        return prev;
      });
    });

    const initNodeId = async () => {
      try {
        const id = await getNodeId();
        if (isMounted) {
          if (id) {
            setNodeId(id);
            sessionStorage.setItem('vortex-node-id', id);
          } else {
            const stored = sessionStorage.getItem('vortex-node-id');
            if (stored) {
              setNodeId(stored);
            } else {
              const devId = 'VX-' + Math.random().toString(36).substring(2, 10).toUpperCase();
              sessionStorage.setItem('vortex-node-id', devId);
              setNodeId(devId);
            }
          }
        }
      } catch {
        if (isMounted) {
          const stored = sessionStorage.getItem('vortex-node-id');
          if (stored) {
            setNodeId(stored);
          } else {
            const devId = 'VX-' + Math.random().toString(36).substring(2, 10).toUpperCase();
            sessionStorage.setItem('vortex-node-id', devId);
            setNodeId(devId);
          }
        }
      }
    };

    const initMesh = async () => {
      try {
        const savedProfile = localStorage.getItem('vortex-profile');
        const displayName = savedProfile
          ? (JSON.parse(savedProfile) as { displayName?: unknown }).displayName
          : undefined;
        if (typeof displayName === 'string' && displayName.trim()) {
          await setNodeName(displayName.trim());
        }
      } catch (profileError) {
        console.warn('Nie udało się przekazać profilu do mesh:', profileError);
      }

      try {
        await startMesh();
        if (isMounted) setError(null);
      } catch (err) {
        // The permission callback retries startup after the user grants BLE.
        if (isMounted) setError(String(err));
      }

      try {
        const initialConnected = await getConnectedAddresses();
        if (isMounted && initialConnected) {
          setConnectedAddresses(initialConnected);
        }
      } catch (err) {
        console.warn('Failed to fetch initial connected addresses:', err);
      }

      try {
        const initialPeers = await getPeers();
        if (isMounted) {
          if (initialPeers && initialPeers.length > 0) {
            setPeers(initialPeers);
          } else if (!(window as any)['__TAURI_INTERNALS__']) {
            setPeers([]);
          }
        }
      } catch (err) {
        console.warn('Dev mode or failed to fetch peers:', err);
        if (isMounted && !(window as any)['__TAURI_INTERNALS__']) {
          setPeers([]);
        }
      }
    };

    // Node ID ładuje się niezależnie od BLE — użytkownik zawsze widzi swoje ID
    initNodeId();
    initMesh();
    const outboxInterval = setInterval(() => {
      if (isMounted && (window as any)['__TAURI_INTERNALS__']) {
        void meshFlushOutbox().catch(() => {});
      }
    }, 30_000);

    return () => {
      clearInterval(outboxInterval);
      isMounted = false;
      discoveredPromise.then(unlisten => unlisten && unlisten());
      bleDiscoveredPromise.then(unlisten => unlisten && unlisten());
      statusPromise.then(unlisten => unlisten && unlisten());
      connectedAddressPromise.then(unlisten => unlisten && unlisten());
      disconnectedAddressPromise.then(unlisten => unlisten && unlisten());
      bleErrorPromise.then(unlisten => unlisten && unlisten());
      permPromise.then(unlisten => unlisten && unlisten());
      locationPromise.then(unlisten => unlisten && unlisten());
    };
  }, []);

  const addPeer = useCallback(async (peerId: string, name: string) => {
    if (!(window as any)['__TAURI_INTERNALS__']) {
      setPeers(prev => {
        if (prev.find(peer => peer.id === peerId)) return prev;
        return [...prev, { id: peerId, name, online: false }];
      });
      return;
    }
    await apiAddPeer(peerId, name);
  }, []);

  return { peers, connected, connectedAddresses, nodeId, error, addPeer, setPeers };
}
