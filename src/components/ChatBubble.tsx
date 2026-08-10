import React from 'react';
import { motion } from 'motion/react';

interface Props {
  text: string;
  sent: boolean;
  timestamp: string;
}

const ChatBubble: React.FC<Props> = ({ text, sent, timestamp }) => {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={`flex flex-col mb-4 ${sent ? 'items-end' : 'items-start'} max-w-[85%] ${sent ? 'self-end ml-auto' : 'self-start mr-auto'}`}
    >
      <div 
        className={`px-4 py-2.5 rounded-2xl break-words whitespace-pre-wrap text-[15px] leading-relaxed shadow-sm
          ${sent 
            ? 'bg-accent text-white rounded-br-sm' 
            : 'bg-secondary text-foreground rounded-bl-sm'
          }`}
      >
        {text}
      </div>
      <span className="text-[11px] text-muted-foreground mt-1 px-1">
        {timestamp}
      </span>
    </motion.div>
  );
};

export default ChatBubble;
