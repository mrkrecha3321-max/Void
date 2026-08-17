import React, { useState, useRef, KeyboardEvent } from 'react';
import { Send } from 'lucide-react';

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
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-3 pb-safe bg-background border-t border-border/50">
      <input
        ref={inputRef}
        type="text"
        className="flex-1 bg-secondary border-none rounded-2xl px-4 py-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground transition-all focus:ring-2 focus:ring-accent/20"
        data-testid="chat-input"
        placeholder="Napisz wiadomość..."
        value={text}
        onChange={e => setText(fitUtf8Limit(e.target.value))}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
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
  );
};

export default MessageInput;
