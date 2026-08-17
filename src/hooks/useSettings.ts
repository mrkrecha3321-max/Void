import { useEffect, useState } from 'react';
import { getMeshSettings, setMeshSettings } from '../api';
import type { CoreMeshSettings } from '../types';

export interface Settings {
  relayNode: boolean;
  batterySave: boolean;
  forceEncrypted: boolean;
  hideNode: boolean;
  rejectNewChats: boolean;
  autoDestruct: boolean;
  locationSharing: boolean;
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
  locationSharing: false,
  vibrations: true,
  sounds: true,
  criticalSos: true,
};

const normalizeSettings = (candidate: unknown): Settings => {
  if (!candidate || typeof candidate !== 'object') return defaultSettings;
  const value = candidate as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(defaultSettings).map(([key, fallback]) => [
      key,
      typeof value[key] === 'boolean' ? value[key] : fallback,
    ]),
  ) as unknown as Settings;
};

const toCoreSettings = (settings: Settings): CoreMeshSettings => ({
  relayNode: settings.relayNode,
  batterySave: settings.batterySave,
  hideNode: settings.hideNode,
  rejectNewChats: settings.rejectNewChats,
  autoDestruct: settings.autoDestruct,
  locationSharing: settings.locationSharing,
});

export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(() => {
    const saved = localStorage.getItem('vortex-settings');
    if (saved) {
      try {
        return { ...normalizeSettings(JSON.parse(saved)), forceEncrypted: true };
      } catch (error) {
        console.error('Failed to parse settings', error);
      }
    }
    return defaultSettings;
  });

  useEffect(() => {
    if (!(window as any)['__TAURI_INTERNALS__']) return;
    let active = true;
    getMeshSettings()
      .then(core => {
        if (!active) return;
        setSettingsState(previous => {
          const merged: Settings = { ...previous, ...core, forceEncrypted: true };
          localStorage.setItem('vortex-settings', JSON.stringify(merged));
          return merged;
        });
      })
      .catch(error => console.error('Nie udało się odczytać ustawień core:', error));
    return () => { active = false; };
  }, []);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettingsState(previous => {
      const next = {
        ...previous,
        [key]: key === 'forceEncrypted' ? true : value,
      };
      localStorage.setItem('vortex-settings', JSON.stringify(next));
      window.dispatchEvent(new CustomEvent('vortex-settings-changed', { detail: next }));
      if ((window as any)['__TAURI_INTERNALS__']) {
        void setMeshSettings(toCoreSettings(next)).catch(error => {
          console.error('Nie udało się zastosować ustawień mesh:', error);
        });
      }
      return next;
    });
  };

  return { settings, updateSetting };
}
