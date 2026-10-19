const AUDIO_MUTE_KEY = 'void_tactical_audio_muted';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      audioCtx = new Ctx();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function isTacticalAudioMuted(): boolean {
  try {
    return localStorage.getItem(AUDIO_MUTE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setTacticalAudioMuted(muted: boolean): void {
  try {
    localStorage.setItem(AUDIO_MUTE_KEY, muted ? 'true' : 'false');
    window.dispatchEvent(new CustomEvent('void-audio-mute-changed', { detail: muted }));
  } catch {
    // ignore storage errors
  }
}

export function toggleTacticalAudioMuted(): boolean {
  const next = !isTacticalAudioMuted();
  setTacticalAudioMuted(next);
  if (!next) {
    playPttClick();
  }
  return next;
}

/** Short mechanical PTT key-down click + 25ms radio squelch tail */
export function playPttClick(): void {
  if (isTacticalAudioMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1800, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.035);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.038);
  } catch {
    // ignore audio context errors
  }
}

/** Classic Walkie-Talkie Roger Beep + white-noise squelch tail on incoming/outgoing transmission */
export function playRogerBeep(): void {
  if (isTacticalAudioMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // 1. Short white-noise squelch burst (30ms)
    const bufferSize = Math.floor(ctx.sampleRate * 0.03);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.15;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1600;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.08, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.005, now + 0.03);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start(now);

    // 2. Dual-tone Roger Beep (1350 Hz -> 1050 Hz)
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1350, now + 0.03);
    osc.frequency.setValueAtTime(1050, now + 0.075);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.setValueAtTime(0.1, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + 0.03);
    osc.stop(now + 0.135);
  } catch {
    // ignore audio context errors
  }
}

/** Tactical SOS high-priority alert tone */
export function playSosAlertTone(): void {
  if (isTacticalAudioMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1320, now + 0.12);
    osc.frequency.setValueAtTime(880, now + 0.24);
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.4);
  } catch {
    // ignore audio context errors
  }
}
