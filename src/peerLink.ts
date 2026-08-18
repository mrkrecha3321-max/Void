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

export const mergePeerLink = (
  current: PeerLinkStatus | undefined,
  next: PeerLinkStatus,
): PeerLinkStatus => {
  if (current === 'ready' && next === 'discovered') return 'ready';
  if (current === 'connected' && next === 'discovered') return 'connected';
  if (current === 'connecting' && next === 'discovered') return 'connecting';
  return next;
};
