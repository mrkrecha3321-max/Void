import React, { useState, useRef } from 'react';
import { Check, CheckCheck, Play, Pause, Mic, Maximize2, X } from 'lucide-react';
import { parseMediaPayload } from '../utils/mediaCodec';

interface Props {
  text: string;
  sent: boolean;
  timestamp: string;
  delivered?: boolean;
  failed?: boolean;
  queued?: boolean;
  transmitting?: boolean;
  error?: string;
  senderName?: string;
  onRetry?: () => void;
}

const ChatBubble: React.FC<Props> = ({
  text,
  sent,
  timestamp,
  delivered,
  failed,
  queued,
  transmitting,
  error,
  senderName,
  onRetry,
}) => {
  const media = parseMediaPayload(text);
  const [playing, setPlaying] = useState(false);
  const [expandedImage, setExpandedImage] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggleVoicePlay = () => {
    if (!media || media.kind !== 'voice') return;
    if (!audioRef.current) {
      const audio = new Audio(`data:${media.mime};base64,${media.dataB64}`);
      audio.onended = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.currentTime = 0;
      audioRef.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  return (
    <div
      className={`flex w-full min-w-0 ${sent ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`flex min-w-0 max-w-[min(82%,22rem)] flex-col ${sent ? 'items-end' : 'items-start'}`}
      >
        {!sent && senderName && (
          <span className="text-[11px] font-bold text-accent px-1.5 mb-0.5 truncate max-w-full">
            {senderName}
          </span>
        )}
        <div
          className={`chat-bubble-text px-3.5 py-2 rounded-2xl text-[15px] leading-relaxed shadow-sm
            ${sent
              ? 'bg-accent text-white rounded-br-md'
              : 'bg-secondary text-foreground rounded-bl-md border border-border/40'
            }`}
        >
          {media?.kind === 'voice' ? (
            <div className="flex items-center gap-3 py-1 min-w-[180px]">
              <button
                type="button"
                onClick={toggleVoicePlay}
                className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-transform active:scale-95 ${
                  sent ? 'bg-black/25 text-white' : 'bg-accent text-white'
                }`}
                aria-label={playing ? 'Zatrzymaj nagranie' : 'Odtwórz nagranie'}
              >
                {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
              </button>
              <div className="flex flex-col flex-1 min-w-0 gap-1">
                <div className="flex items-end gap-1 h-4">
                  {[40, 75, 55, 95, 65, 85, 50, 90, 60, 80, 45, 70].map((h, idx) => (
                    <span
                      key={idx}
                      style={{ height: `${playing ? Math.max(25, (h + idx * 17) % 100) : h}%` }}
                      className={`w-1 rounded-full transition-all ${
                        sent ? 'bg-white/80' : 'bg-accent'
                      }`}
                    />
                  ))}
                </div>
                <div className="flex items-center justify-between text-[11px] opacity-85 font-mono">
                  <span className="inline-flex items-center gap-1">
                    <Mic size={11} /> PTT Opus
                  </span>
                  <span>{Math.max(1, Math.round(media.durationSec || 1))}s</span>
                </div>
              </div>
            </div>
          ) : media?.kind === 'image' ? (
            <div className="flex flex-col gap-1.5 py-0.5">
              <div
                className="relative rounded-xl overflow-hidden cursor-pointer group border border-black/15"
                onClick={() => setExpandedImage(true)}
              >
                <img
                  src={`data:${media.mime};base64,${media.dataB64}`}
                  alt="Szkic Mesh"
                  className="max-h-56 w-auto object-cover rounded-xl block"
                />
                <span className="absolute bottom-1.5 right-1.5 bg-black/60 text-white p-1 rounded-lg opacity-80 group-hover:opacity-100">
                  <Maximize2 size={12} />
                </span>
              </div>
              <span className="text-[11px] opacity-80 font-mono">
                📷 Szkic Mesh ({Math.max(1, Math.round((media.dataB64.length * 0.75) / 1024))} KB)
              </span>
            </div>
          ) : (
            text
          )}
        </div>
        <div className={`flex items-center gap-1 mt-1 px-1 max-w-full ${sent ? 'justify-end' : 'justify-start'}`}>
          <span className="text-[11px] text-muted-foreground shrink-0">
            {timestamp}
          </span>
          {sent && (
            <span className={failed ? 'text-red-500' : 'text-muted-foreground'} title={error}>
              {failed ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-[11px] font-semibold">Nie wysłano</span>
                  {onRetry && (
                    <button
                      type="button"
                      className="text-[11px] font-bold underline"
                      onClick={onRetry}
                    >
                      Ponów
                    </button>
                  )}
                </span>
              ) : queued ? (
                <span className="text-[11px] font-semibold text-amber-500">W kolejce DTN</span>
              ) : transmitting ? (
                <span className="text-[11px] font-semibold text-amber-500">Wysyłanie…</span>
              ) : delivered ? (
                <CheckCheck size={14} className="text-emerald-500" />
              ) : (
                <Check size={14} />
              )}
            </span>
          )}
        </div>
      </div>

      {expandedImage && media?.kind === 'image' && (
        <div
          className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setExpandedImage(false)}
        >
          <button
            type="button"
            onClick={() => setExpandedImage(false)}
            className="absolute top-6 right-6 p-2.5 rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label="Zamknij podgląd"
          >
            <X size={22} />
          </button>
          <img
            src={`data:${media.mime};base64,${media.dataB64}`}
            alt="Podgląd zdjęcia Mesh"
            className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl"
          />
        </div>
      )}
    </div>
  );
};

export default ChatBubble;

