"use client";

import { useEffect, useRef } from "react";
import { usePrefs } from "@/lib/store";

/**
 * Each blob drifts on its own slow, organic sine/cosine orbit and is pulled
 * gently toward the cursor (followMouse = how strongly, 0–1). Only `transform`
 * is mutated per frame (never layout properties), so this stays GPU-composited
 * and smooth even with five large blurred layers running at once.
 */
const BLOBS = [
  { color: "232,162,56", size: 620, baseX: 22, baseY: 28, speed: 0.00016, phase: 0, orbit: 70, followMouse: 0.16 }, // amber
  { color: "241,108,44", size: 560, baseX: 78, baseY: 22, speed: 0.00021, phase: 2.1, orbit: 60, followMouse: 0.11 }, // orange
  { color: "236,72,153", size: 520, baseX: 66, baseY: 74, speed: 0.00014, phase: 4.2, orbit: 65, followMouse: 0.09 }, // magenta
  { color: "178,166,82", size: 580, baseX: 20, baseY: 78, speed: 0.00019, phase: 1.4, orbit: 55, followMouse: 0.13 }, // olive gold
  { color: "34,197,94", size: 420, baseX: 48, baseY: 14, speed: 0.00024, phase: 3.3, orbit: 50, followMouse: 0.07 }, // green
] as const;

export default function AuroraBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const blobRefs = useRef<(HTMLDivElement | null)[]>([]);
  const mouse = useRef({ x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5 });
  const reduceMotion = usePrefs((s) => s.reduceMotion);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();

    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      mouse.current.targetX = (e.clientX - rect.left) / rect.width;
      mouse.current.targetY = (e.clientY - rect.top) / rect.height;
    };
    window.addEventListener("mousemove", onMove, { passive: true });

    const paint = (now: number) => {
      const t = now - start;
      const rect = containerRef.current?.getBoundingClientRect();
      const w = rect?.width || 1;
      const h = rect?.height || 1;

      // Critically damped ease toward the cursor — smooth, never jittery or overshooting.
      mouse.current.x += (mouse.current.targetX - mouse.current.x) * 0.045;
      mouse.current.y += (mouse.current.targetY - mouse.current.y) * 0.045;
      const mdx = (mouse.current.x - 0.5) * w;
      const mdy = (mouse.current.y - 0.5) * h;

      blobRefs.current.forEach((el, i) => {
        if (!el) return;
        const b = BLOBS[i];
        const driftX = Math.sin(t * b.speed + b.phase) * b.orbit;
        const driftY = Math.cos(t * b.speed * 1.3 + b.phase) * b.orbit;
        const x = driftX + mdx * b.followMouse;
        const y = driftY + mdy * b.followMouse;
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      });

      if (!reduceMotion) raf = requestAnimationFrame(paint);
    };

    raf = requestAnimationFrame(paint);
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, [reduceMotion]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden" aria-hidden>
      <div className="absolute inset-0 bg-ink-950" />
      {BLOBS.map((b, i) => (
        <div
          key={i}
          ref={(el) => {
            blobRefs.current[i] = el;
          }}
          className="absolute rounded-full"
          style={{
            width: b.size,
            height: b.size,
            left: `${b.baseX}%`,
            top: `${b.baseY}%`,
            marginLeft: -b.size / 2,
            marginTop: -b.size / 2,
            background: `radial-gradient(circle, rgba(${b.color},0.6) 0%, rgba(${b.color},0.25) 45%, rgba(${b.color},0) 72%)`,
            filter: "blur(70px)",
            mixBlendMode: "screen",
            willChange: "transform",
          }}
        />
      ))}
      {/* Soft grain-free vignette so the far edges settle back to near-black, matching the rest of the site. */}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(ellipse 90% 80% at 50% 45%, transparent 40%, rgba(6,6,6,0.7) 100%)" }}
      />
    </div>
  );
}
