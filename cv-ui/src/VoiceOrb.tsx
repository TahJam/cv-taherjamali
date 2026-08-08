import { useRef, useEffect, useCallback } from 'react';
import { SESSION_TIMEOUT_S } from './useVoiceMode';
import type { VoiceStatus } from './useVoiceMode';

interface VoiceOrbProps {
  status: VoiceStatus;
  getInputLevel: () => number;
  getOutputLevel: () => number;
  remainingSeconds: number;
  transcript?: string;
  statusText?: string;
  isMobile: boolean;
}

// Spring interpolation
function lerp(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

// CSS variable reader (cached per page load)
let cachedColors: { from: string; to: string } | null = null;
function getThemeColors(): { from: string; to: string } {
  if (cachedColors) return cachedColors;
  const style = getComputedStyle(document.documentElement);
  const from = style.getPropertyValue('--gradient-from').trim();
  const to = style.getPropertyValue('--gradient-to').trim();
  cachedColors = {
    from: from ? `hsl(${from})` : '#22d3ee',
    to: to ? `hsl(${to})` : '#a855f7',
  };
  return cachedColors;
}

export default function VoiceOrb({
  status,
  getInputLevel,
  getOutputLevel,
  remainingSeconds,
  transcript,
  statusText,
  isMobile,
}: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const smoothInputRef = useRef(0);
  const smoothOutputRef = useRef(0);
  const timeRef = useRef(0);
  const reducedMotion = useRef(false);

  useEffect(() => {
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = isMobile ? 200 : 160;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const baseRadius = size * 0.28;

    // Smooth levels
    const inputLevel = getInputLevel();
    const outputLevel = getOutputLevel();
    smoothInputRef.current = lerp(smoothInputRef.current, inputLevel, 0.15);
    smoothOutputRef.current = lerp(smoothOutputRef.current, outputLevel, 0.15);

    const smoothInput = smoothInputRef.current;
    const smoothOutput = smoothOutputRef.current;

    timeRef.current += 0.02;
    const t = timeRef.current;

    ctx.clearRect(0, 0, size, size);

    const colors = getThemeColors();

    // Determine visual parameters by state
    let radius = baseRadius;
    let distortion = 0;
    let opacity = 1;
    let gradientAngle = t * 0.5;
    let pulseScale = 1;

    if (reducedMotion.current) {
      // Reduced motion: simple opacity changes
      switch (status) {
        case 'connecting':
          opacity = 0.5 + Math.sin(t * 2) * 0.2;
          break;
        case 'listening':
          opacity = 0.7 + smoothInput * 0.3;
          break;
        case 'thinking':
          opacity = 0.4 + Math.sin(t * 3) * 0.2;
          break;
        case 'speaking':
          opacity = 0.7 + smoothOutput * 0.3;
          break;
        default:
          opacity = 0.6;
      }
    } else {
      switch (status) {
        case 'idle':
          pulseScale = 0.95 + Math.sin(t * 1.5) * 0.05;
          distortion = 0.02;
          opacity = 0.6;
          break;
        case 'connecting':
          gradientAngle = t * 3;
          pulseScale = 0.97 + Math.sin(t * 4) * 0.03;
          distortion = 0.05;
          opacity = 0.7 + Math.sin(t * 2) * 0.15;
          break;
        case 'listening':
          distortion = 0.05 + smoothInput * 0.25;
          radius = baseRadius * (1 + smoothInput * 0.15);
          opacity = 0.8;
          break;
        case 'thinking':
          gradientAngle = t * 2;
          distortion = 0.08 + Math.sin(t * 3) * 0.04;
          pulseScale = 0.98 + Math.sin(t * 2.5) * 0.02;
          opacity = 0.7;
          break;
        case 'speaking':
          distortion = 0.08 + smoothOutput * 0.35;
          radius = baseRadius * (1 + smoothOutput * 0.2);
          opacity = 0.9;
          break;
      }
    }

    radius *= pulseScale;

    // Draw orb with organic bezier distortion
    const segments = 64;
    ctx.beginPath();

    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;

      // Noise displacement for organic shape
      const n1 = Math.sin(angle * 3 + t * 2) * distortion;
      const n2 = Math.cos(angle * 5 + t * 1.5) * distortion * 0.7;
      const n3 = Math.sin(angle * 7 + t * 3) * distortion * 0.3;
      const displacement = 1 + n1 + n2 + n3;

      const r = radius * displacement;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.closePath();

    // Gradient fill
    const gx1 = cx + Math.cos(gradientAngle) * radius;
    const gy1 = cy + Math.sin(gradientAngle) * radius;
    const gx2 = cx - Math.cos(gradientAngle) * radius;
    const gy2 = cy - Math.sin(gradientAngle) * radius;

    const gradient = ctx.createLinearGradient(gx1, gy1, gx2, gy2);

    // Color based on state
    if (status === 'listening') {
      gradient.addColorStop(0, colors.from);
      gradient.addColorStop(1, adjustAlpha(colors.to, 0.6));
    } else if (status === 'speaking') {
      gradient.addColorStop(0, colors.to);
      gradient.addColorStop(1, colors.from);
    } else {
      gradient.addColorStop(0, adjustAlpha(colors.from, 0.7));
      gradient.addColorStop(1, adjustAlpha(colors.to, 0.7));
    }

    ctx.globalAlpha = opacity;
    ctx.fillStyle = gradient;
    ctx.fill();

    // Glow effect
    if (status === 'listening' || status === 'speaking') {
      const level = status === 'listening' ? smoothInput : smoothOutput;
      ctx.shadowBlur = 20 + level * 30;
      ctx.shadowColor = status === 'listening' ? colors.from : colors.to;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.globalAlpha = 1;

    // Timer ring
    if (status !== 'idle' && status !== 'error') {
      const timerRadius = radius + 15;
      const progress = remainingSeconds / SESSION_TIMEOUT_S;

      // Background ring
      ctx.beginPath();
      ctx.arc(cx, cy, timerRadius, -Math.PI / 2, Math.PI * 2 - Math.PI / 2);
      ctx.strokeStyle = adjustAlpha(colors.from, 0.15);
      ctx.lineWidth = 2;
      ctx.stroke();

      // Progress ring
      ctx.beginPath();
      ctx.arc(cx, cy, timerRadius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = remainingSeconds <= 15 ? '#ef4444' : adjustAlpha(colors.from, 0.6);
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [status, remainingSeconds, getInputLevel, getOutputLevel, isMobile]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-6">
      <canvas
        ref={canvasRef}
        aria-label="Voice visualization"
        role="img"
        className="block"
      />

      {/* Status text */}
      <p
        className={`text-sm text-muted-foreground text-center transition-opacity ${
          status === 'error' ? 'text-red-400' : ''
        }`}
        aria-live="polite"
      >
        {statusText}
      </p>

      {/* Timer (warning at 15s) */}
      {status !== 'idle' && status !== 'error' && (
        <p className={`text-xs tabular-nums ${
          remainingSeconds <= 15 ? 'text-red-400' : 'text-muted-foreground'
        }`}>
          {formatTime(remainingSeconds)}
        </p>
      )}

      {/* Live subtitles — shows last ~120 chars so user reads what's being spoken now */}
      {transcript && (
        <p className="text-xs text-muted-foreground text-center max-w-[280px] leading-relaxed">
          {transcript.length > 120
            ? '…' + transcript.slice(-120).trimStart()
            : transcript}
        </p>
      )}
    </div>
  );
}

function adjustAlpha(color: string, alpha: number): string {
  // For hsl() / hsla() colors — use modern syntax with slash for alpha
  if (color.startsWith('hsl')) {
    // Extract the values inside parentheses
    const inner = color.replace(/hsla?\(/, '').replace(/\)$/, '');
    return `hsl(${inner} / ${alpha})`;
  }
  // For hex colors, convert to rgba
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
