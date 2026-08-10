import { useState } from 'react';

export interface Settings {
  relayNode: boolean;
  batterySave: boolean;
  forceEncrypted: boolean;
  hideNode: boolean;
  rejectNewChats: boolean;
  autoDestruct: boolean;
  vibrations: boolean;
  sounds: boolean;
  criticalSos: boolean;
}

const defaultSettings: Settings = {
  relayNode: true,
  batterySave: false,
  forceEncrypted: true,
  hideNode: false,
  rejectNewChats: false,
  autoDestruct: false,
  vibrations: true,
  sounds: true,
  criticalSos: true,
};

export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(() => {
    const saved = localStorage.getItem('vortex-settings');
    if (saved) {
      try {
        return { ...defaultSettings, ...JSON.parse(saved) };
      } catch (e) {
        console.error('Failed to parse settings', e);
      }
    }
    return defaultSettings;
  });

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettingsState((prev) => {
      const newSettings = { ...prev, [key]: value };
      localStorage.setItem('vortex-settings', JSON.stringify(newSettings));
      return newSettings;
    });
  };

  return { settings, updateSetting };
}
