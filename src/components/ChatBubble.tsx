import React from 'react';
import { Check, CheckCheck } from 'lucide-react';

interface Props {
  text: string;
  sent: boolean;
  timestamp: string;
  delivered?: boolean;
  failed?: boolean;
  queued?: boolean;
  transmitting?: boolean;
  error?: string;
  onRetry?: () => void;
}

const ChatBubble: React.FC<Props> = ({
  text,
  sent,
  timestamp,
  delivered,
  failed,
  queued,
  transmitting,
  error,
  onRetry,
}) => {
  return (
    <div
      className={`flex w-full min-w-0 ${sent ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`flex min-w-0 max-w-[min(82%,22rem)] flex-col ${sent ? 'items-end' : 'items-start'}`}
      >
        <div
          className={`chat-bubble-text px-3.5 py-2 rounded-2xl text-[15px] leading-relaxed shadow-sm
            ${sent
              ? 'bg-accent text-white rounded-br-md'
              : 'bg-secondary text-foreground rounded-bl-md'
            }`}
        >
          {text}
        </div>
        <div className={`flex items-center gap-1 mt-1 px-1 max-w-full ${sent ? 'justify-end' : 'justify-start'}`}>
          <span className="text-[11px] text-muted-foreground shrink-0">
            {timestamp}
          </span>
          {sent && (
            <span className={failed ? 'text-red-500' : 'text-muted-foreground'} title={error}>
              {failed ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-[11px] font-semibold">Nie wysłano</span>
                  {onRetry && (
                    <button
                      type="button"
                      className="text-[11px] font-bold underline"
                      onClick={onRetry}
                    >
                      Ponów
                    </button>
                  )}
                </span>
              ) : queued ? (
                <span className="text-[11px] font-semibold text-amber-500">W kolejce</span>
              ) : transmitting ? (
                <span className="text-[11px] font-semibold text-amber-500">Wysyłanie…</span>
              ) : delivered ? (
                <CheckCheck size={14} className="text-blue-500" />
              ) : (
                <Check size={14} />
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatBubble;
