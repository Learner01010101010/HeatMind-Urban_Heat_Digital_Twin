"use client";

import { AlertTriangle, ArrowRight, Check, Crosshair, Loader2, MapPin, ShieldCheck, Sun, TreePine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Logo from "@/components/shell/Logo";
import AuroraBackground from "@/components/ui/AuroraBackground";
import PersonaSelector from "@/components/ui/PersonaSelector";
import { startWatch, stopWatch, useGeo } from "@/lib/geolocation";
import { ensureUser, useMeta } from "@/lib/hooks";
import { useMap, usePrefs } from "@/lib/store";

/**
 * Fallback starts, for when the browser will not give a position or the user is
 * standing outside the modelled corridor.
 *
 * Hard-coded because the alternative is worse: the named places live in the zone
 * payload, and that is 16 MB — nothing worth pulling into an onboarding screen to
 * populate three buttons. /api/meta only carries the bbox and a centre point, and
 * "start at 18.468, 73.841" is not a choice anyone can make. These three are the
 * ends and middle of the corridor and are checked against the zone's own places.
 */
const ANCHORS: { lat: number; lon: number; label: string; hint: string }[] = [
  { lat: 18.4427, lon: 73.8318, label: "Narhe", hint: "TSSM BSCOER campus" },
  { lat: 18.4537, lon: 73.8563, label: "Katraj", hint: "near Bharati Vidyapeeth" },
  { lat: 18.5007, lon: 73.8586, label: "Swargate", hint: "north end of the zone" },
];

export default function Onboarding() {
  const router = useRouter();
  const persona = usePrefs((s) => s.persona);
  const units = usePrefs((s) => s.units);
  const seniorMode = usePrefs((s) => s.seniorMode);
  const set = usePrefs((s) => s.set);
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const meta = useMeta();
  const bbox = meta.data?.zone.bbox;
  const geoStatus = useGeo((s) => s.status);
  const geoLat = useGeo((s) => s.lat);
  const geoLon = useGeo((s) => s.lon);
  const geoError = useGeo((s) => s.error);
  const [picked, setPicked] = useState<{ lat: number; lon: number; label: string } | null>(null);

  // The twin is built around wherever this resolves to, and nothing is rendered
  // until it does — hence asking before letting anyone in, rather than after.
  const startAt =
    picked ??
    (geoStatus === "inside" && geoLat !== null && geoLon !== null
      ? { lat: geoLat, lon: geoLon, label: "My location" }
      : null);

  // Ask as soon as there is a bbox to test the fix against. One shot: a declined
  // prompt is a decision, not something to nag about, and the anchors below are a
  // complete answer on their own.
  const asked = useRef(false);
  useEffect(() => {
    if (!bbox || asked.current) return;
    asked.current = true;
    startWatch(bbox);
  }, [bbox]);

  const pickAnchor = (a: (typeof ANCHORS)[number]) => {
    // Stop following a position that is outside the zone: left running it would
    // keep overwriting the trip origin with a point no route can start from.
    stopWatch();
    setPicked({ lat: a.lat, lon: a.lon, label: a.label });
  };

  const start = async () => {
    if (!startAt) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureUser(sample);
    } catch {
      setErr("Couldn't reach the HeatMind engine — you can still explore, but the Passport needs the backend on :8000.");
    }
    useMap.getState().set({ startAt, revealOn: true });
    set({ onboarded: true });
    router.push("/");
  };

  return (
    <main className="min-h-dvh relative bg-ink-950 overflow-hidden">
      <AuroraBackground />
      <div className="relative z-10 max-w-5xl mx-auto px-5 py-10 md:py-16 grid md:grid-cols-[1fr_1.15fr] gap-10 items-start">
        <section
          className="relative rounded-[40px] p-6 md:p-8 -m-6 md:-m-8"
          style={{ background: "radial-gradient(closest-side, rgba(6,6,6,0.55), rgba(6,6,6,0.22) 65%, transparent 100%)" }}
        >
          <div className="flex items-center gap-3 mb-8">
            <Logo size={40} />
            <div>
              <div className="font-extrabold text-xl text-ink-100 leading-none">HeatMind AI</div>
              <div className="text-[12px] text-ink-400">Urban heat digital twin</div>
            </div>
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold leading-[1.05] tracking-tight text-ink-100">
            The same street can be 10°C hotter than the one next to it.
          </h1>
          <p className="text-ink-400 mt-5 text-[15px] leading-relaxed max-w-md">
            Weather apps give one number for the whole city. HeatMind models heat street by street across south Pune — Narhe, Katraj, Bharati Vidyapeeth and up to Swargate — forecasts it three hours ahead, and routes you through the shade.
          </p>
          <ul className="mt-7 space-y-3 text-[14px] text-ink-200">
            <li className="flex gap-3">
              <Sun size={18} className="text-ink-400 shrink-0 mt-0.5" /> Live sun-angle shadow simulation from real building footprints
            </li>
            <li className="flex gap-3">
              <TreePine size={18} className="text-ink-400 shrink-0 mt-0.5" /> Routes scored for <i>your</i> body, not a generic average
            </li>
            <li className="flex gap-3">
              <ShieldCheck size={18} className="text-ink-400 shrink-0 mt-0.5" /> Every score explained in plain language
            </li>
          </ul>
        </section>

        <section className="bg-ink-900/90 border border-white/[0.08] rounded-3xl p-5 md:p-6">
          <h2 className="font-extrabold text-lg text-ink-100">Who&apos;s heading out?</h2>
          <p className="text-[13px] text-ink-400 mb-4">Identical heat isn&apos;t equally risky for everyone. Your persona sets how the risk engine weighs each factor.</p>
          <PersonaSelector
            value={persona}
            onChange={(p) => set({ persona: p, ...(p === "senior" ? { seniorMode: true } : {}) })}
          />

          {/* Senior Mode is chosen here and only here. It changes which vehicles are
              offered, when a route is called out as too hot, what the SOS button
              does and how routes are scored — all of which someone should be opting
              into deliberately at the start, not discovering behind a toggle in the
              middle of a trip. Picking the Senior persona turns it on; it can be
              turned back off, because the two are not the same claim. */}
          <div className="mt-5">
            <div className="text-[12px] font-bold text-ink-300 mb-2">Mode</div>
            <div className="flex rounded-2xl bg-ink-950 p-1 gap-1" role="radiogroup" aria-label="App mode">
              {([false, true] as const).map((v) => (
                <button
                  key={String(v)}
                  role="radio"
                  aria-checked={seniorMode === v}
                  onClick={() => set({ seniorMode: v })}
                  className={`flex-1 rounded-xl px-3 py-2.5 text-left transition-colors ${seniorMode === v ? "bg-white/[0.1]" : "hover:bg-white/[0.04]"}`}
                >
                  <span className={`block text-[13.5px] font-bold ${seniorMode === v ? "text-ink-100" : "text-ink-300"}`}>
                    {v ? "Senior" : "Standard"}
                  </span>
                  <span className="block text-[11.5px] text-ink-400 leading-snug mt-0.5">
                    {v
                      ? "Larger text, walk/car/bus only, earlier heat warnings, rest stops preferred"
                      : "Everything on, all travel modes"}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 grid sm:grid-cols-2 gap-3">
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.07] p-3">
              <div className="text-[12px] font-bold text-ink-300 mb-2">Units</div>
              <div className="flex rounded-xl bg-ink-950 p-1" role="radiogroup" aria-label="Temperature units">
                {(["C", "F"] as const).map((u) => (
                  <button key={u} role="radio" aria-checked={units === u} onClick={() => set({ units: u })} className={`flex-1 rounded-lg py-1.5 text-[13px] font-bold ${units === u ? "bg-white/[0.1] text-ink-100" : "text-ink-400"}`}>
                    °{u}
                  </button>
                ))}
              </div>
            </div>
            <label className="rounded-2xl bg-white/[0.03] border border-white/[0.07] p-3 flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} className="mt-1 accent-ink-100 w-4 h-4" />
              <span>
                <span className="block text-[13px] font-bold text-ink-100">Preload a sample week</span>
                <span className="block text-[11.5px] text-ink-400">Fills your Heat Passport with clearly-labelled sample trips (removable).</span>
              </span>
            </label>
          </div>

          <div className="mt-3 rounded-2xl bg-white/[0.03] border border-white/[0.07] p-3">
            <div className="flex items-center gap-2 text-[12px] font-bold text-ink-300 mb-1">
              <MapPin size={13} /> Where are you starting?
            </div>
            <p className="text-[11.5px] text-ink-400 leading-relaxed mb-3">
              The twin is built in 3D around you, street by street — so it needs a starting point to know which part of south Pune to raise.
            </p>

            {geoStatus === "locating" && (
              <div className="flex items-center gap-2 text-[13px] text-ink-300">
                <Loader2 size={14} className="animate-spin" /> Finding you…
              </div>
            )}

            {startAt && (
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink-100">
                <Check size={14} className="text-[#6fbf5e]" />
                Starting at {startAt.label}
                {picked && (
                  <button onClick={() => setPicked(null)} className="ml-auto text-[11.5px] font-medium text-ink-400 hover:text-ink-200 underline">
                    change
                  </button>
                )}
              </div>
            )}

            {!startAt && geoStatus !== "locating" && (
              <>
                {geoStatus === "outside" && (
                  <p className="flex items-start gap-2 text-[12px] text-ink-300 mb-3">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5 text-[#e8a238]" />
                    Found you, but you&apos;re outside the modelled corridor. Pick a start inside it:
                  </p>
                )}
                {(geoStatus === "denied" || geoStatus === "unavailable") && (
                  <p className="flex items-start gap-2 text-[12px] text-ink-300 mb-3">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5 text-[#e8a238]" />
                    {geoError ?? "No position available."} Pick a start instead:
                  </p>
                )}
                <div className="grid gap-1.5">
                  {ANCHORS.map((a) => (
                    <button
                      key={a.label}
                      onClick={() => pickAnchor(a)}
                      className="flex items-center gap-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] px-3 py-2 text-left transition"
                    >
                      <MapPin size={13} className="text-ink-400 shrink-0" />
                      <span className="text-[13px] font-semibold text-ink-100">{a.label}</span>
                      <span className="text-[11.5px] text-ink-400">{a.hint}</span>
                    </button>
                  ))}
                </div>
                {(geoStatus === "denied" || geoStatus === "unavailable" || geoStatus === "idle") && bbox && (
                  <button
                    onClick={() => startWatch(bbox)}
                    className="mt-2 flex items-center gap-1.5 text-[12px] font-semibold text-ink-300 hover:text-ink-100 transition"
                  >
                    <Crosshair size={12} /> Try my location again
                  </button>
                )}
              </>
            )}
          </div>

          {err && <p className="text-[12.5px] text-ink-300 mt-3">{err}</p>}
          <button
            onClick={start}
            disabled={busy || !startAt}
            className="mt-4 w-full flex items-center justify-center gap-2 rounded-full bg-ink-100 hover:bg-white text-ink-950 font-semibold py-3.5 text-[15px] transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : null}
            {startAt ? "Enter the heat twin" : "Choose a starting point"} <ArrowRight size={18} />
          </button>
        </section>
      </div>
    </main>
  );
}
