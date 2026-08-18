import React, { useEffect, useRef } from 'react';
import { Smile } from 'lucide-react';

interface Props {
  open: boolean;
  onToggle: () => void;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

// A compact, dependency-free emoji set. Emojis are plain Unicode characters and
// travel over the mesh as normal UTF-8 text (subject to the same 2048-byte
// limit as every other message).
const EMOJIS: string[] = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
  '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😛', '😜',
  '🤪', '😎', '🤓', '🧐', '🤔', '🤨', '😐', '😑', '😶', '😏',
  '😒', '🙄', '😬', '😮', '😯', '😲', '😳', '🥺', '😢', '😭',
  '😤', '😠', '😡', '🤬', '🤯', '😱', '😨', '😰', '😥', '😓',
  '🤗', '🤔', '🤭', '🤫', '🤥', '😴', '🤤', '😵', '🤒', '🤕',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '✌️', '🤝', '👋', '🫡',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🔥', '✨',
  '⚠️', '🚨', '🆘', '✅', '❌', '❓', '❗', '💯', '🎉', '🎯',
];

const EmojiPicker: React.FC<Props> = ({ open, onToggle, onPick, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    return () => document.removeEventListener('mousedown', handlePointer);
  }, [open, onClose]);

  return (
    <div className="relative flex-shrink-0" ref={containerRef}>
      <button
        type="button"
        onClick={onToggle}
        aria-label="Wstaw emotkę"
        aria-expanded={open}
        className="flex items-center justify-center w-10 h-10 rounded-full text-muted-foreground hover:text-accent hover:bg-secondary transition-colors"
      >
        <Smile size={22} />
      </button>

      {open && (
        <div className="absolute bottom-12 left-0 w-[296px] max-w-[80vw] max-h-60 overflow-y-auto emoji-grid bg-card border border-border rounded-2xl shadow-2xl p-2 grid grid-cols-8 gap-1 z-50">
          {EMOJIS.map(emoji => (
            <button
              key={emoji}
              type="button"
              onClick={() => onPick(emoji)}
              className="text-xl leading-none p-1.5 rounded-lg hover:bg-secondary active:scale-90 transition-transform"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default EmojiPicker;
