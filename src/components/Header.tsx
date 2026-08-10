import React from 'react';
import { ChevronLeft } from 'lucide-react';

interface Props {
  title: string;
  onBack?: () => void;
  rightElement?: React.ReactNode;
  subtitle?: string;
  centerTitle?: boolean;
}

const Header: React.FC<Props> = ({
  title,
  onBack,
  rightElement,
  subtitle,
  centerTitle = false,
}) => {
  return (
    <div className="flex items-center px-4 py-3 bg-background border-b border-border/50 sticky top-0 z-10 pt-safe">
      {onBack && (
        <button 
          className="p-2 -ml-2 mr-2 rounded-full text-accent hover:bg-secondary transition-colors" 
          onClick={onBack} 
          aria-label="Wstecz"
        >
          <ChevronLeft size={28} strokeWidth={2.5} />
        </button>
      )}
      <div
        className="flex-1 flex flex-col min-w-0"
        style={{ alignItems: centerTitle ? 'center' : 'flex-start' }}
      >
        <span className="text-xl font-bold text-foreground truncate">{title}</span>
        {subtitle && <span className="text-xs text-muted-foreground truncate">{subtitle}</span>}
      </div>
      {rightElement && (
        <div className="ml-2 flex items-center">{rightElement}</div>
      )}
    </div>
  );
};

export default Header;
