import React from 'react';
import { MessageSquare, Users, Menu, Radio } from 'lucide-react';
import { motion } from 'motion/react';

type Tab = 'chats' | 'radar' | 'contacts' | 'menu';

interface Props {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const TABS: { id: Tab; label: string; icon: React.FC<any> }[] = [
  { id: 'chats', label: 'Void', icon: MessageSquare },
  { id: 'radar', label: 'Skaner', icon: Radio },
  { id: 'contacts', label: 'Kontakty', icon: Users },
  { id: 'menu', label: 'Menu', icon: Menu },
];

const BottomNav: React.FC<Props> = ({ activeTab, onTabChange }) => {
  return (
    <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto flex bg-secondary/80 backdrop-blur-md border-t border-border/50 pb-safe z-50 px-2" role="navigation" aria-label="Nawigacja główna">
      {TABS.map(tab => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        
        return (
          <button
            key={tab.id}
            className={`flex-1 flex flex-col items-center justify-center py-3 relative cursor-pointer outline-none ${isActive ? 'text-accent' : 'text-muted-foreground hover:text-foreground transition-colors'}`}
            onClick={() => onTabChange(tab.id)}
            aria-label={tab.label}
            aria-current={isActive ? 'page' : undefined}
          >
            {isActive && (
              <motion.div
                layoutId="bottom-nav-indicator"
                className="absolute top-0 w-8 h-1 bg-accent rounded-b-full"
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              />
            )}
            <Icon size={24} strokeWidth={isActive ? 2.5 : 2} className="mb-1" />
            <span className="text-[10px] font-medium tracking-wide">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default BottomNav;
