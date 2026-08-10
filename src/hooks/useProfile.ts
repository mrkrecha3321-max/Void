import { useState, useEffect } from 'react';

export interface UserProfile {
  displayName: string;
  avatarLetter?: string;
}

export function useProfile() {
  const [profile, setProfile] = useState<UserProfile>({ displayName: 'Anonimowy' });

  useEffect(() => {
    const saved = localStorage.getItem('vortex-profile');
    if (saved) {
      try {
        setProfile(JSON.parse(saved));
      } catch (e) {
        // ignore
      }
    }
  }, []);

  const updateProfile = (newProfile: UserProfile) => {
    setProfile(newProfile);
    localStorage.setItem('vortex-profile', JSON.stringify(newProfile));
  };

  return { profile, updateProfile };
}
