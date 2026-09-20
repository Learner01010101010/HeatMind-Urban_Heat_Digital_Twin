"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import RoutePanel from "@/components/hud/RoutePanel";
import { api, type Route } from "@/lib/api";

/** Shareable deep link to one route's detail (routes live in server memory for recent comparisons). */
export default function RoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [route, setRoute] = useState<Route | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    api.route(id).then(setRoute).catch(() => setErr(true));
  }, [id]);

  return (
    <main className="min-h-dvh pb-28 md:pb-16">
      <div className="max-w-[560px] mx-auto px-5 pt-6">
        <Link href="/" className="press inline-flex items-center gap-1 text-[15px] text-cool-300 font-medium mb-6">
          <ChevronLeft size={20} /> Map
        </Link>
        {err && <div className="rounded-[22px] bg-white/[0.04] p-5 text-ink-300">This route has expired from server memory — plan it again on the map.</div>}
        {!route && !err && <div className="skeleton h-96 rounded-[26px]" />}
        {route && (
          <>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-400">
              {route.label} · {route.title}
            </div>
            <h1 className="text-[32px] font-semibold tracking-tight mb-6">Route detail</h1>
            <RoutePanel route={route} />
          </>
        )}
      </div>
    </main>
  );
}
