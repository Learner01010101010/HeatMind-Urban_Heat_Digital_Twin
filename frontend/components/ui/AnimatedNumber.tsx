"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefs } from "@/lib/store";

/** Smoothly tweens between values (tabular numerals so digits never jitter). */
export default function AnimatedNumber({ value, digits = 0, duration = 500, className, suffix = "" }: { value: number; digits?: number; duration?: number; className?: string; suffix?: string }) {
  const reduce = usePrefs((s) => s.reduceMotion);
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef(0);

  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    const dur = reduce ? 1 : duration;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = a + (value - a) * e;
      from.current = v;
      setShown(v);
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration, reduce]);

  return (
    <span className={`tabular ${className ?? ""}`}>
      {shown.toFixed(digits)}
      {suffix}
    </span>
  );
}
