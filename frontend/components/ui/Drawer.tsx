"use client";

import { X } from "lucide-react";
import { useEffect } from "react";

/**
 * Responsive drawer: a floating side panel on desktop (map stays interactive),
 * a bottom sheet on mobile.
 */
export default function Drawer({
  open,
  onClose,
  title,
  eyebrow,
  children,
  width = 420,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);

  return (
    <>
      {/* mobile scrim */}
      <div
        className={`md:hidden fixed inset-0 z-[65] bg-black/40 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="false"
        aria-hidden={!open}
        className={`glass-strong fixed z-[70] flex flex-col
          inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[28px]
          md:inset-x-auto md:bottom-4 md:top-4 md:right-4 md:max-h-none md:rounded-[28px]
          transition-transform duration-500 [transition-timing-function:cubic-bezier(.16,1,.3,1)]
          ${open ? "translate-y-0 md:translate-x-0" : "translate-y-[105%] md:translate-y-0 md:translate-x-[calc(100%+2rem)]"}`}
        style={{ width: undefined, ["--w" as string]: `${width}px` }}
      >
        <div className="md:w-[var(--w)] flex flex-col min-h-0 h-full">
          <div className="md:hidden flex justify-center pt-2.5">
            <span className="w-10 h-1.5 rounded-full bg-white/15" />
          </div>
          <header className="flex items-start justify-between gap-3 px-6 pt-4 md:pt-6 pb-3">
            <div className="min-w-0">
              {eyebrow && <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-400 mb-1">{eyebrow}</div>}
              {title && <h2 className="text-[22px] font-semibold tracking-tight text-ink-100 leading-tight">{title}</h2>}
            </div>
            <button onClick={onClose} className="press grid place-items-center w-9 h-9 rounded-full bg-white/6 hover:bg-white/12 text-ink-300 shrink-0" aria-label="Close">
              <X size={17} />
            </button>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-6 pb-8">{open ? children : null}</div>
        </div>
      </aside>
    </>
  );
}
