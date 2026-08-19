import React from 'react';

interface Props {
  name: string;
  size?: number;
  online?: boolean;
  avatarLetter?: string;
}

const AVATAR_COLORS = [
  '#3b82f6',
  '#ec4899',
  '#f97316',
  '#10b981',
  '#8b5cf6',
  '#ef4444',
];

function getAvatarColor(name: string): string {
  const hash = name
    .split('')
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(' ')
    .slice(0, 2)
    .map(w => w[0] || '')
    .join('')
    .toUpperCase();
}

const Avatar: React.FC<Props> = ({ name, size = 48, online, avatarLetter }) => {
  const bg = getAvatarColor(name);
  const initials = avatarLetter || getInitials(name);
  const fontSize = Math.round(size * 0.38);

  return (
    <div className="relative inline-block flex-shrink-0" style={{ width: size, height: size }}>
      <div
        className="rounded-full flex items-center justify-center font-bold text-white overflow-hidden shadow-sm shadow-black/20"
        style={{
          width: size,
          height: size,
          backgroundColor: bg,
          fontSize,
        }}
      >
        <span className="leading-none tracking-wider">{initials}</span>
      </div>
      {online && (
        <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 rounded-full border-2 border-background" />
      )}
    </div>
  );
};

export default Avatar;
