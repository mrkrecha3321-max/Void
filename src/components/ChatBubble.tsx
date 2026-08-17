import React from 'react';
import { motion } from 'motion/react';
import { Check, CheckCheck } from 'lucide-react';

interface Props {
  text: string;
  sent: boolean;
  timestamp: string;
  delivered?: boolean;
  failed?: boolean;
  queued?: boolean;
  error?: string;
}

const ChatBubble: React.FC<Props> = ({ text, sent, timestamp, delivered, failed, queued, error }) => {
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
      <div className="flex items-center gap-1 mt-1 px-1 justify-end">
        <span className="text-[11px] text-muted-foreground">
          {timestamp}
        </span>
        {sent && (
          <span className={failed ? 'text-red-500' : 'text-muted-foreground'} title={error}>
            {failed ? (
              <span className="text-[11px] font-semibold">Nie wysłano</span>
            ) : queued ? (
              <span className="text-[11px] font-semibold text-amber-500">W kolejce</span>
            ) : delivered ? (
              <CheckCheck size={14} className="text-blue-500" />
            ) : (
              <Check size={14} />
            )}
          </span>
        )}
      </div>
    </motion.div>
  );
};

export default ChatBubble;
