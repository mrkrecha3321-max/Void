export const VOID_MEDIA_PREFIX = 'VOID_MEDIA:';
export const MAX_VOICE_SECONDS = 15;
export const MAX_MEDIA_PAYLOAD_CHARS = 19_500;

export interface VoidMediaPayload {
  kind: 'voice' | 'image';
  mime: string;
  dataB64: string;
  durationSec?: number;
  width?: number;
  height?: number;
  caption?: string;
}

export function encodeMediaPayload(payload: VoidMediaPayload): string {
  const serialized = `${VOID_MEDIA_PREFIX}${JSON.stringify(payload)}`;
  if (serialized.length > MAX_MEDIA_PAYLOAD_CHARS) {
    throw new Error('Plik multimedialny przekracza limit pakietu BLE Mesh (ok. 15 KB).');
  }
  return serialized;
}

export function parseMediaPayload(text: string): VoidMediaPayload | null {
  if (!text || !text.startsWith(VOID_MEDIA_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(VOID_MEDIA_PREFIX.length)) as VoidMediaPayload;
    if (
      (parsed.kind === 'voice' || parsed.kind === 'image') &&
      typeof parsed.mime === 'string' &&
      typeof parsed.dataB64 === 'string' &&
      parsed.dataB64.length > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatMediaPreview(text: string): string {
  const media = parseMediaPayload(text);
  if (!media) return text;
  if (media.kind === 'voice') {
    const sec = media.durationSec ? `${Math.round(media.durationSec)}s` : '';
    return `🎙️ Notatka głosowa ${sec}`.trim();
  }
  return media.caption ? `📷 ${media.caption}` : '📷 Zdjęcie (Szkic Mesh)';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Compresses an image File/Blob into a compact WebP or JPEG thumbnail that fits
 * inside a BLE Mesh envelope (<= 14 KB binary / <= 19 KB base64 JSON).
 */
export async function compressImageForMesh(
  file: File,
  caption?: string,
): Promise<string> {
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Nie udało się wczytać obrazu'));
      el.src = bitmapUrl;
    });

    const attempts: Array<{ maxDim: number; quality: number; mime: string }> = [
      { maxDim: 240, quality: 0.52, mime: 'image/webp' },
      { maxDim: 200, quality: 0.42, mime: 'image/webp' },
      { maxDim: 160, quality: 0.35, mime: 'image/webp' },
      { maxDim: 200, quality: 0.45, mime: 'image/jpeg' },
      { maxDim: 150, quality: 0.35, mime: 'image/jpeg' },
    ];

    for (const attempt of attempts) {
      const scale = Math.min(1, attempt.maxDim / Math.max(img.width || 1, img.height || 1));
      const width = Math.max(1, Math.round((img.width || 160) * scale));
      const height = Math.max(1, Math.round((img.height || 160) * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL(attempt.mime, attempt.quality);
      const commaIdx = dataUrl.indexOf(',');
      if (commaIdx === -1) continue;
      const header = dataUrl.slice(0, commaIdx);
      const actualMime = header.includes('image/webp') ? 'image/webp' : 'image/jpeg';
      const dataB64 = dataUrl.slice(commaIdx + 1);

      const payload: VoidMediaPayload = {
        kind: 'image',
        mime: actualMime,
        dataB64,
        width,
        height,
        caption: caption?.trim() ? caption.trim().slice(0, 80) : undefined,
      };
      const candidate = `${VOID_MEDIA_PREFIX}${JSON.stringify(payload)}`;
      if (candidate.length <= MAX_MEDIA_PAYLOAD_CHARS) {
        return candidate;
      }
    }

    throw new Error('Obraz jest zbyt złożony — nie udało się skompresować poniżej 15 KB.');
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

export interface VoiceRecorderSession {
  stop: () => Promise<string>;
  cancel: () => void;
}

/**
 * Starts a low-bitrate Opus voice recording (6 kbps, up to 15 seconds)
 * suitable for multi-hop BLE Mesh transmission.
 */
export async function startVoiceRecording(): Promise<VoiceRecorderSession> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Mikrofon jest niedostępny na tym urządzeniu.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 8000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const preferredMimes = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  const selectedMime =
    preferredMimes.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || '';

  const recorder = new MediaRecorder(stream, {
    ...(selectedMime ? { mimeType: selectedMime } : {}),
    audioBitsPerSecond: 6000,
  });

  const chunks: BlobPart[] = [];
  const startedAt = Date.now();

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data);
    }
  };

  recorder.start(250);

  const stopTracks = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  return {
    stop: () =>
      new Promise<string>((resolve, reject) => {
        recorder.onstop = async () => {
          stopTracks();
          try {
            const durationSec = Math.max(1, Math.min(MAX_VOICE_SECONDS, (Date.now() - startedAt) / 1000));
            const mime = recorder.mimeType || selectedMime || 'audio/webm';
            const blob = new Blob(chunks, { type: mime });
            const buffer = await blob.arrayBuffer();
            if (buffer.byteLength === 0) {
              reject(new Error('Nagranie jest puste.'));
              return;
            }
            const dataB64 = arrayBufferToBase64(buffer);
            const encoded = encodeMediaPayload({
              kind: 'voice',
              mime,
              dataB64,
              durationSec: Math.round(durationSec * 10) / 10,
            });
            resolve(encoded);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };
        if (recorder.state !== 'inactive') {
          recorder.stop();
        } else {
          stopTracks();
          reject(new Error('Nagrywanie zostało już zatrzymane.'));
        }
      }),
    cancel: () => {
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        // ignore
      }
      stopTracks();
    },
  };
}
