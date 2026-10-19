import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { Send, Smile, Mic, Image as ImageIcon, Square, Trash2 } from 'lucide-react';
import {
  compressImageForMesh,
  startVoiceRecording,
  type VoiceRecorderSession,
} from '../utils/mediaCodec';
import { playPttClick } from '../utils/tacticalAudio';

interface Props {
  onSend: (text: string) => void;
}

const MAX_MESSAGE_BYTES = 2048;
const encoder = new TextEncoder();

const EMOJIS = [
  '😀', '😁', '😂', '🥹', '😊', '😍', '😘', '😎',
  '🤔', '😴', '😭', '😡', '👍', '👎', '👏', '🙏',
  '❤️', '🔥', '✨', '🎉', '✅', '❌', '📍', '⚠️',
  '🏠', '🚗', '☕', '🍕', '🌙', '☀️', '💪', '👋',
];

const fitUtf8Limit = (value: string): string => {
  if (encoder.encode(value).length <= MAX_MESSAGE_BYTES) return value;
  let result = '';
  for (const character of value) {
    if (encoder.encode(result + character).length > MAX_MESSAGE_BYTES) break;
    result += character;
  }
  return result;
};

const MessageInput: React.FC<Props> = ({ onSend }) => {
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [mediaBusy, setMediaBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeRecordingRef = useRef<VoiceRecorderSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      activeRecordingRef.current?.cancel();
    };
  }, []);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    setShowEmoji(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertEmoji = (emoji: string) => {
    setText(previous => fitUtf8Limit(previous + emoji));
    inputRef.current?.focus();
  };

  const handleStopAndSendRecording = async () => {
    const session = activeRecordingRef.current;
    if (!session) return;
    if (timerRef.current) clearInterval(timerRef.current);
    activeRecordingRef.current = null;
    setRecording(false);
    setMediaBusy(true);
    try {
      const encodedPayload = await session.stop();
      onSend(encodedPayload);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setMediaBusy(false);
    }
  };

  const handleStartRecording = async () => {
    if (recording || mediaBusy) return;
    try {
      playPttClick();
      setRecordSeconds(0);
      const session = await startVoiceRecording();
      activeRecordingRef.current = session;
      setRecording(true);
      timerRef.current = setInterval(() => {
        setRecordSeconds(s => {
          if (s + 1 >= 15) {
            void handleStopAndSendRecording();
            return 15;
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancelRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    activeRecordingRef.current?.cancel();
    activeRecordingRef.current = null;
    setRecording(false);
  };

  const handleImagePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMediaBusy(true);
    try {
      const encodedPayload = await compressImageForMesh(file);
      onSend(encodedPayload);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setMediaBusy(false);
    }
  };

  return (
    <div className="shrink-0 bg-background border-t border-border/50">
      {showEmoji && !recording && (
        <div className="grid grid-cols-8 gap-1 px-3 pt-2 pb-1 max-h-36 overflow-y-auto">
          {EMOJIS.map(emoji => (
            <button
              key={emoji}
              type="button"
              className="h-9 rounded-lg text-xl leading-none hover:bg-secondary active:scale-95"
              onClick={() => insertEmoji(emoji)}
              aria-label={`Emotka ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImagePick}
      />

      {recording ? (
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 pb-safe bg-red-500/10">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-3 h-3 rounded-full bg-red-500 animate-ping shrink-0" />
            <span className="text-sm font-bold text-red-500 font-mono">
              PTT {recordSeconds}s / 15s
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCancelRecording}
              className="px-3 py-1.5 rounded-xl bg-secondary text-muted-foreground hover:text-foreground text-xs font-semibold flex items-center gap-1"
            >
              <Trash2 size={14} /> Anuluj
            </button>
            <button
              type="button"
              onClick={handleStopAndSendRecording}
              className="px-3.5 py-1.5 rounded-xl bg-emerald-500 text-black text-xs font-bold flex items-center gap-1.5 shadow-md"
            >
              <Square size={13} fill="currentColor" /> Wyślij głos
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-1.5 px-2.5 py-2 pb-safe">
          <button
            type="button"
            className={`flex items-center justify-center w-9 h-9 rounded-full flex-shrink-0 ${showEmoji ? 'bg-accent/15 text-accent' : 'bg-secondary text-muted-foreground'}`}
            onClick={() => setShowEmoji(open => !open)}
            aria-label="Emotki"
            aria-pressed={showEmoji}
          >
            <Smile size={19} />
          </button>
          <button
            type="button"
            disabled={mediaBusy}
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-secondary text-muted-foreground hover:text-foreground flex-shrink-0 disabled:opacity-50"
            aria-label="Wyślij skompresowane zdjęcie"
            title="Wyślij szkic zdjęcia przez Mesh (≤15 KB)"
          >
            <ImageIcon size={18} />
          </button>
          <button
            type="button"
            disabled={mediaBusy}
            onClick={handleStartRecording}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-secondary text-muted-foreground hover:text-accent flex-shrink-0 disabled:opacity-50"
            aria-label="Nagraj notatkę głosową PTT"
            title="Nagraj notatkę głosową Opus (do 15s)"
          >
            <Mic size={18} />
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            className="flex-1 min-w-0 max-h-28 bg-secondary border-none rounded-2xl px-3.5 py-2 text-[15px] text-foreground outline-none placeholder:text-muted-foreground resize-none overflow-y-auto focus:ring-2 focus:ring-accent/20"
            data-testid="chat-input"
            placeholder={mediaBusy ? 'Kompresja pakietu Mesh…' : 'Napisz wiadomość…'}
            value={text}
            onChange={e => setText(fitUtf8Limit(e.target.value))}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            enterKeyHint="send"
          />
          <button
            className="flex items-center justify-center w-10 h-10 rounded-full bg-accent text-white border-none cursor-pointer flex-shrink-0 transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="chat-send-btn"
            onClick={handleSend}
            aria-label="Wyślij wiadomość"
            disabled={!text.trim() || mediaBusy}
          >
            <Send size={18} className="ml-0.5" />
          </button>
        </div>
      )}
    </div>
  );
};

export default MessageInput;

