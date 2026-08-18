import React, { useState, useRef, KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import EmojiPicker from './EmojiPicker';

interface Props {
  onSend: (text: string) => void;
}

const MAX_MESSAGE_BYTES = 2048;
const encoder = new TextEncoder();

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
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    setShowEmoji(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertEmoji = (emoji: string) => {
    const next = fitUtf8Limit(text + emoji);
    setText(next);
    inputRef.current?.focus();
  };

  return (
    <div className="flex items-end gap-1.5 px-2 sm:px-3 py-2 pb-safe bg-background border-t border-border/50">
      <EmojiPicker
        open={showEmoji}
        onToggle={() => setShowEmoji(open => !open)}
        onPick={insertEmoji}
        onClose={() => setShowEmoji(false)}
      />
      <input
        ref={inputRef}
        type="text"
        enterKeyHint="send"
        className="flex-1 min-w-0 bg-secondary border-none rounded-2xl px-4 py-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground transition-all focus:ring-2 focus:ring-accent/20"
        data-testid="chat-input"
        placeholder="Napisz wiadomość..."
        value={text}
        onChange={e => setText(fitUtf8Limit(e.target.value))}
        onKeyDown={handleKeyDown}
        onFocus={() => setShowEmoji(false)}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        className="flex items-center justify-center w-11 h-11 rounded-full bg-accent text-white border-none cursor-pointer flex-shrink-0 transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="chat-send-btn"
        onClick={handleSend}
        aria-label="Wyślij wiadomość"
        disabled={!text.trim()}
      >
        <Send size={18} className="ml-0.5" />
      </button>
    </div>
  );
};

export default MessageInput;
