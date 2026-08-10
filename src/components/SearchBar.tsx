import React from 'react';
import { Search, X } from 'lucide-react';

interface Props {
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
  onAddContact?: (id: string) => void;
}

export const SearchBar: React.FC<Props> = ({
  placeholder = 'Szukaj lub wpisz ID...',
  value = '',
  onChange,
  onAddContact,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && value.trim()) {
      onAddContact?.(value.trim());
    }
  };

  return (
    <div className="flex items-center gap-2 bg-secondary/70 backdrop-blur-sm rounded-2xl px-4 py-2.5 mx-4 my-2 mb-4 border border-border/50 focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/20 transition-all">
      <Search className="text-muted-foreground" size={18} />
      <input
        type="search"
        className="flex-1 bg-transparent border-none text-foreground text-sm outline-none placeholder:text-muted-foreground"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange?.(e.target.value)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {value.length > 0 && (
        <button
          className="text-muted-foreground hover:text-foreground p-1 rounded-full bg-black/10 dark:bg-white/10"
          onClick={() => onChange?.('')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
};

export default SearchBar;
