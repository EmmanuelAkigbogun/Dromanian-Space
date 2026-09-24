import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import styles from './MeetingChat.module.css';

interface ChatMessage {
  id: string;
  channel_id: string;
  content: string;
  user_id: string;
  created_at: string;
  display_name?: string;
}

interface MeetingChatProps {
  callId: string;
  channelId?: string;
}

export function MeetingChat({ callId, channelId }: MeetingChatProps) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !channelId) return;

    const fetchMessages = async () => {
      const { data } = await supabase
        .from('messages')
        .select('id, content, user_id, created_at')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true })
        .limit(100);
      if (data) setMessages(data as ChatMessage[]);
    };
    fetchMessages();

    const ch = supabase
      .channel(`meeting-chat:${callId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const msg = payload.new as ChatMessage;
          if (msg.channel_id === channelId) {
            setMessages((prev) => [...prev, msg]);
          }
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [isOpen, channelId, callId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || !channelId || !userId || !currentWorkspace) return;

    const content = input.trim();
    setInput('');

    await supabase.from('messages').insert({
      channel_id: channelId,
      user_id: userId,
      content,
    });
  }, [input, channelId, userId, currentWorkspace]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      <button
        type="button"
        className={styles.toggleButton}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Toggle meeting chat"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.panel}>
          <div className={styles.header}>
            <span className={styles.headerTitle}>Meeting Chat</span>
            <button type="button" className={styles.closeButton} onClick={() => setIsOpen(false)} aria-label="Close chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className={styles.messages}>
            {messages.length === 0 && (
              <div className={styles.empty}>No messages yet</div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={styles.message}>
                <span className={styles.messageAuthor}>{msg.user_id.slice(0, 8)}...</span>
                <span className={styles.messageContent}>{msg.content}</span>
                <span className={styles.messageTime}>
                  {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <div className={styles.inputArea}>
            <input
              type="text"
              className={styles.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              aria-label="Meeting chat message"
            />
            <button
              type="button"
              className={styles.sendButton}
              onClick={sendMessage}
              disabled={!input.trim()}
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
