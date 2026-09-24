import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import styles from './Whiteboard.module.css';

interface DrawEvent {
  type: 'draw' | 'erase' | 'clear' | 'shape';
  userId: string;
  points?: { x: number; y: number }[];
  color?: string;
  width?: number;
  shape?: 'rect' | 'circle' | 'line';
  start?: { x: number; y: number };
  end?: { x: number; y: number };
}

interface WhiteboardProps {
  callId: string;
}

const COLORS = ['#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
const WIDTHS = [2, 4, 8, 12];

export function Whiteboard({ callId }: WhiteboardProps) {
  const { userId } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [tool, setTool] = useState<'draw' | 'erase' | 'rect' | 'circle' | 'line'>('draw');
  const [color, setColor] = useState('#ffffff');
  const [lineWidth, setLineWidth] = useState(4);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const pointsRef = useRef<{ x: number; y: number }[]>([]);
  const lastBroadcastRef = useRef<number>(0);
  const lastBroadcastIdxRef = useRef<number>(0);
  const channelRef = useRef<any>(null);

  const getCanvasCoords = useCallback((e: React.MouseEvent | React.TouchEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  const drawLine = useCallback(
    (ctx: CanvasRenderingContext2D, points: { x: number; y: number }[], strokeColor: string, width: number) => {
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    },
    [],
  );

  const drawShape = useCallback(
    (ctx: CanvasRenderingContext2D, shape: string, start: { x: number; y: number }, end: { x: number; y: number }, strokeColor: string, width: number) => {
      ctx.beginPath();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';

      if (shape === 'rect') {
        ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      } else if (shape === 'circle') {
        const rx = Math.abs(end.x - start.x) / 2;
        const ry = Math.abs(end.y - start.y) / 2;
        const cx = start.x + (end.x - start.x) / 2;
        const cy = start.y + (end.y - start.y) / 2;
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shape === 'line') {
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }
    },
    [],
  );

  const handleEvent = useCallback(
    (ctx: CanvasRenderingContext2D, event: DrawEvent) => {
      if (event.type === 'draw' && event.points) {
        drawLine(ctx, event.points, event.color || '#ffffff', event.width || 4);
      } else if (event.type === 'erase' && event.points) {
        ctx.globalCompositeOperation = 'destination-out';
        drawLine(ctx, event.points, 'rgba(0,0,0,1)', (event.width || 4) * 3);
        ctx.globalCompositeOperation = 'source-over';
      } else if (event.type === 'shape' && event.shape && event.start && event.end) {
        drawShape(ctx, event.shape, event.start, event.end, event.color || '#ffffff', event.width || 4);
      } else if (event.type === 'clear') {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      }
    },
    [drawLine, drawShape],
  );

  useEffect(() => {
    if (!isOpen || !callId) return;

    channelRef.current = supabase.channel(`whiteboard:${callId}`);
    channelRef.current
      .on('broadcast', { event: 'draw-event' }, (payload: any) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        handleEvent(ctx, payload.payload as DrawEvent);
      })
      .subscribe();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, [isOpen, callId, handleEvent]);

  const broadcastEvent = useCallback((event: DrawEvent) => {
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'draw-event',
        payload: event,
      });
    }
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const coords = getCanvasCoords(e);
      setIsDrawing(true);
      lastBroadcastRef.current = 0;
      lastBroadcastIdxRef.current = 0;

      if (tool === 'draw' || tool === 'erase') {
        pointsRef.current = [coords];
      } else {
        setStartPoint(coords);
      }
    },
    [getCanvasCoords, tool],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawing) return;
      const coords = getCanvasCoords(e);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const now = performance.now();
      const THROTTLE_MS = 80;

      if (tool === 'draw') {
        pointsRef.current.push(coords);
        drawLine(ctx, pointsRef.current, color, lineWidth);
        if (now - lastBroadcastRef.current >= THROTTLE_MS) {
          const newPoints = pointsRef.current.slice(lastBroadcastIdxRef.current);
          if (newPoints.length > 0) {
            broadcastEvent({ type: 'draw', userId: userId ?? '', points: newPoints, color, width: lineWidth });
          }
          lastBroadcastRef.current = now;
          lastBroadcastIdxRef.current = pointsRef.current.length;
        }
      } else if (tool === 'erase') {
        pointsRef.current.push(coords);
        ctx.globalCompositeOperation = 'destination-out';
        drawLine(ctx, pointsRef.current, 'rgba(0,0,0,1)', lineWidth * 3);
        ctx.globalCompositeOperation = 'source-over';
        if (now - lastBroadcastRef.current >= THROTTLE_MS) {
          const newPoints = pointsRef.current.slice(lastBroadcastIdxRef.current);
          if (newPoints.length > 0) {
            broadcastEvent({ type: 'erase', userId: userId ?? '', points: newPoints, width: lineWidth });
          }
          lastBroadcastRef.current = now;
          lastBroadcastIdxRef.current = pointsRef.current.length;
        }
      } else if (startPoint) {
        // Preview shape (no broadcast until pointer up)
      }
    },
    [isDrawing, tool, color, lineWidth, userId, getCanvasCoords, drawLine, broadcastEvent, startPoint],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawing) return;
      setIsDrawing(false);

      if ((tool === 'rect' || tool === 'circle' || tool === 'line') && startPoint) {
        const end = getCanvasCoords(e);
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            drawShape(ctx, tool, startPoint, end, color, lineWidth);
            broadcastEvent({ type: 'shape', userId: userId ?? '', shape: tool, start: startPoint, end, color, width: lineWidth });
          }
        }
        setStartPoint(null);
      } else if (tool === 'draw' || tool === 'erase') {
        const newPoints = pointsRef.current.slice(lastBroadcastIdxRef.current);
        if (newPoints.length > 0) {
          broadcastEvent({ type: tool, userId: userId ?? '', points: newPoints, ...(tool === 'draw' ? { color } : {}), width: lineWidth });
        }
      }

      pointsRef.current = [];
      lastBroadcastRef.current = 0;
      lastBroadcastIdxRef.current = 0;
    },
    [isDrawing, tool, startPoint, userId, getCanvasCoords, drawShape, color, lineWidth, broadcastEvent],
  );

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    broadcastEvent({ type: 'clear', userId: userId ?? '' });
  }, [userId, broadcastEvent]);

  return (
    <>
      <button
        type="button"
        className={styles.toggleButton}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Toggle whiteboard"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <path d="M3 9h18" />
          <path d="M9 21V9" />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.panel}>
          <div className={styles.toolbar}>
            <button type="button" className={`${styles.toolButton} ${tool === 'draw' ? styles.active : ''}`} onClick={() => setTool('draw')} title="Draw">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                <path d="M2 2l7.586 7.586" />
                <circle cx="11" cy="11" r="2" />
              </svg>
            </button>
            <button type="button" className={`${styles.toolButton} ${tool === 'erase' ? styles.active : ''}`} onClick={() => setTool('erase')} title="Erase">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 20H7L3 16l7-7 11 11-1 0z" />
                <path d="M18 13L11 6" />
              </svg>
            </button>
            <button type="button" className={`${styles.toolButton} ${tool === 'rect' ? styles.active : ''}`} onClick={() => setTool('rect')} title="Rectangle">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              </svg>
            </button>
            <button type="button" className={`${styles.toolButton} ${tool === 'circle' ? styles.active : ''}`} onClick={() => setTool('circle')} title="Circle">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
              </svg>
            </button>
            <button type="button" className={`${styles.toolButton} ${tool === 'line' ? styles.active : ''}`} onClick={() => setTool('line')} title="Line">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="19" x2="19" y2="5" />
              </svg>
            </button>
            <div className={styles.separator} />
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`${styles.colorButton} ${color === c ? styles.colorActive : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
            <div className={styles.separator} />
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className={`${styles.widthButton} ${lineWidth === w ? styles.widthActive : ''}`}
                onClick={() => setLineWidth(w)}
                title={`${w}px`}
              >
                <div style={{ width: w, height: w, borderRadius: '50%', backgroundColor: 'currentColor' }} />
              </button>
            ))}
            <div className={styles.separator} />
            <button type="button" className={styles.toolButton} onClick={clearCanvas} title="Clear canvas">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
            <div className={styles.separator} />
            <button type="button" className={styles.toolButton} onClick={() => setIsOpen(false)} title="Close whiteboard">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className={styles.canvasContainer}>
            <canvas
              ref={canvasRef}
              width={800}
              height={600}
              className={styles.canvas}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            />
          </div>
        </div>
      )}
    </>
  );
}
