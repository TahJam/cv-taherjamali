import { useRef, useCallback, useEffect } from 'react';

/**
 * Hook that extracts audio levels at 60fps via requestAnimationFrame.
 * Returns a normalized 0-1 RMS value.
 */
export function useAudioAnalyser() {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const levelRef = useRef(0);
  const rafRef = useRef(0);
  const reducedMotion = useRef(false);

  useEffect(() => {
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const tick = useCallback(() => {
    const analyser = analyserRef.current;
    const dataArray = dataArrayRef.current;
    if (!analyser || !dataArray) return;

    analyser.getByteTimeDomainData(dataArray);

    // Calculate RMS
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const normalized = (dataArray[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);

    // Normalize to 0-1 range (typical speech RMS is 0.02-0.15)
    levelRef.current = Math.min(1, rms * 6);

    // Reduced motion: update less frequently
    if (reducedMotion.current) {
      rafRef.current = window.setTimeout(() => {
        rafRef.current = requestAnimationFrame(tick);
      }, 100) as unknown as number;
    } else {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, []);

  const connect = useCallback((node: AnalyserNode) => {
    analyserRef.current = node;
    node.fftSize = 256;
    dataArrayRef.current = new Uint8Array(node.frequencyBinCount);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const disconnect = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    analyserRef.current = null;
    dataArrayRef.current = null;
    levelRef.current = 0;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { levelRef, connect, disconnect };
}
