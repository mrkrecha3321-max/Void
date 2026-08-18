export type PeerLinkStatus =
  | 'discovered'
  | 'connecting'
  | 'connected'
  | 'ready'
  | 'disconnected';

export const isPeerOnline = (status?: PeerLinkStatus, online?: boolean): boolean =>
  status === 'ready' || (status === undefined && online === true);

export const peerLinkLabel = (status?: PeerLinkStatus, online?: boolean): string => {
  switch (status) {
    case 'discovered':
      return 'Wykryty';
    case 'connecting':
      return 'Łączenie';
    case 'connected':
      return 'Połączony';
    case 'ready':
      return 'Gotowy';
    case 'disconnected':
      return 'Rozłączony';
    default:
      return online ? 'Gotowy' : 'Rozłączony';
  }
};

/** Match a full VX- Node ID with a radar short suffix or another full ID. */
export const peerIdsMatch = (left?: string, right?: string): boolean => {
  if (!left || !right) return false;
  if (left === right) return true;
  const normalize = (value: string): string =>
    value.replace(/^VX-/i, '').toUpperCase();
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(b) || b.endsWith(a);
};

export const preferFullPeerId = (current: string, incoming: string): string => {
  const incomingFull = /^VX-[0-9A-F]{32}$/i.test(incoming);
  const currentFull = /^VX-[0-9A-F]{32}$/i.test(current);
  if (incomingFull && !currentFull && peerIdsMatch(current, incoming)) {
    return incoming;
  }
  return current;
};

export const mergePeerLink = (
  current: PeerLinkStatus | undefined,
  next: PeerLinkStatus,
): PeerLinkStatus => {
  if (current === 'ready' && next === 'discovered') return 'ready';
  if (current === 'connected' && next === 'discovered') return 'connected';
  if (current === 'connecting' && next === 'discovered') return 'connecting';
  return next;
};
