"use client";

import { FlaskConical, HeartPulse, LifeBuoy, Map as MapIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useNav } from "@/lib/navigation";
import { useMap } from "@/lib/store";
import CityOpsAdvisory, { CityOpsToggle } from "@/components/hud/CityOpsAdvisory";

// The Planner is a city-scale intervention tool, not something anyone reaches for
// mid-walk, and it was taking a permanent third of the bar on every screen. It is
// still at /planner; it just no longer competes with the two things a person out in
// the heat actually needs. Emergency takes its place because that is the one action
// whose worth is measured in how fast it can be found.
const ITEMS = [
  { href: "/", label: "Twin", icon: MapIcon },
  { href: "/passport", label: "Heat Passport", icon: HeartPulse },
  { href: "/city-lab", label: "City Lab", icon: FlaskConical },
];

/** Top-level navigation, visible on every screen (top pill on desktop, tab bar on phones).
 *  "How it works" lives in the profile drawer instead. */
export default function GlobalNav() {
  const path = usePathname();
  const setMap = useMap((s) => s.set);
  // Guidance owns the screen. Passport and Planner are planning surfaces, and on
  // desktop this pill is centred on the same bar the turn instruction occupies —
  // it was drawing straight through the distance to the next turn.
  const navigating = useNav((s) => s.active);
  if (path.startsWith("/onboarding") || navigating) return null;
  const isOn = (href: string) => (href === "/" ? path === "/" || path.startsWith("/route") : path.startsWith(href));

  return (
    <>
      <CityOpsAdvisory />
      <nav className="hidden md:flex fixed top-5 left-1/2 -translate-x-1/2 z-[60] glass rounded-full p-1 gap-0.5" aria-label="Main">
        {ITEMS.map((it) => {
          const on = isOn(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              aria-current={on ? "page" : undefined}
              className={`press ${it.href === "/city-lab" ? "hidden xl:flex" : "flex"} items-center gap-2 h-10 rounded-full px-3.5 text-[13px] font-medium transition-colors ${on ? "bg-white/[0.12] text-ink-100" : "text-ink-300 hover:text-ink-100 hover:bg-white/[0.05]"}`}
              title={it.label}
            >
              <it.icon size={16} />
              <span className="hidden 2xl:inline">{it.label}</span>
              {it.href === "/passport" && <span className="2xl:hidden">Passport</span>}
              {it.href === "/city-lab" && <span className="2xl:hidden">City Lab</span>}
            </Link>
          );
        })}
        <CityOpsToggle />
        <button
          onClick={() => setMap({ emergencyOpen: true })}
          className="press hm-sos flex items-center gap-2 h-10 rounded-full px-3.5 text-[13px] font-semibold"
          title="Find the nearest water, shade or rest right now"
        >
          <LifeBuoy size={16} />
          <span className="hidden 2xl:inline">Emergency</span>
          <span className="2xl:hidden">SOS</span>
        </button>
      </nav>

      <Link href="/city-lab" aria-current={isOn("/city-lab") ? "page" : undefined} className="hidden md:flex xl:hidden fixed right-5 top-[84px] z-[60] glass rounded-full px-4 py-2.5 items-center gap-2 text-xs text-[#8ad8b0] border border-[#8ad8b0]/20"><FlaskConical size={16} />City Lab</Link>

      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-[60] flex items-stretch h-[calc(56px+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] bg-ink-950/85 backdrop-blur-2xl border-t border-white/[0.06]"
        aria-label="Main"
      >
        {ITEMS.map((it) => {
          const on = isOn(it.href);
          return (
            <Link key={it.href} href={it.href} aria-current={on ? "page" : undefined} className={`flex-1 flex flex-col items-center justify-center gap-1 ${on ? "text-ink-100" : "text-ink-400"}`}>
              <it.icon size={20} />
              <span className="text-[10.5px] font-medium">{it.label}</span>
            </Link>
          );
        })}
        <CityOpsToggle />
        <button
          onClick={() => setMap({ emergencyOpen: true })}
          className="flex-1 flex flex-col items-center justify-center gap-1 text-[#ff8a7a]"
          aria-label="Emergency — nearest water, shade or rest"
        >
          <LifeBuoy size={20} />
          <span className="text-[10.5px] font-semibold">Emergency</span>
        </button>
      </nav>
    </>
  );
}
