import { useState, useEffect } from 'react';

export interface UserProfile {
  displayName: string;
  avatarLetter?: string;
}

const normalizeProfile = (candidate: unknown): UserProfile => {
  if (!candidate || typeof candidate !== 'object') return { displayName: 'Anonimowy' };
  const value = candidate as { displayName?: unknown; avatarLetter?: unknown };
  const displayName = typeof value.displayName === 'string'
    ? value.displayName.trim().slice(0, 80)
    : 'Anonimowy';
  const avatarLetter = typeof value.avatarLetter === 'string'
    ? value.avatarLetter.slice(0, 8)
    : undefined;
  return { displayName: displayName || 'Anonimowy', avatarLetter };
};

export function useProfile() {
  const [profile, setProfile] = useState<UserProfile>({ displayName: 'Anonimowy' });

  useEffect(() => {
    const saved = localStorage.getItem('vortex-profile');
    if (!saved) return;
    try {
      setProfile(normalizeProfile(JSON.parse(saved)));
    } catch {
      localStorage.removeItem('vortex-profile');
    }
  }, []);

  const updateProfile = (newProfile: UserProfile) => {
    const normalized = normalizeProfile(newProfile);
    setProfile(normalized);
    localStorage.setItem('vortex-profile', JSON.stringify(normalized));
  };

  return { profile, updateProfile };
}
