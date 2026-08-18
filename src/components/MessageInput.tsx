import React, { useState, useRef, KeyboardEvent } from 'react';
import { Send, Smile } from 'lucide-react';

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
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div className="shrink-0 bg-background border-t border-border/50">
      {showEmoji && (
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
      <div className="flex items-end gap-2 px-3 py-2 pb-safe">
        <button
          type="button"
          className={`flex items-center justify-center w-10 h-10 rounded-full flex-shrink-0 ${showEmoji ? 'bg-accent/15 text-accent' : 'bg-secondary text-muted-foreground'}`}
          onClick={() => setShowEmoji(open => !open)}
          aria-label="Emotki"
          aria-pressed={showEmoji}
        >
          <Smile size={20} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          className="flex-1 min-w-0 max-h-28 bg-secondary border-none rounded-2xl px-4 py-2.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground resize-none overflow-y-auto focus:ring-2 focus:ring-accent/20"
          data-testid="chat-input"
          placeholder="Napisz wiadomość…"
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
          disabled={!text.trim()}
        >
          <Send size={18} className="ml-0.5" />
        </button>
      </div>
    </div>
  );
};

export default MessageInput;
