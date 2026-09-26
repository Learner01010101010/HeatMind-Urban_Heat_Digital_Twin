"use client";

/**
 * NIOSH WBGT work/rest guidance — a static reference panel.
 *
 * Nothing here is computed and nothing here is wired to the twin. It is on screen
 * to name the standard this product's heat accumulator is aiming at, so a reader
 * can see the target rather than take the thresholds on faith.
 *
 * The figures are illustrative and rounded. The published NIOSH criteria depend on
 * acclimatisation, clothing and metabolic rate, and the real document is the
 * authority — this table is a shape, not a lookup.
 */

const WORKLOADS = ["Light", "Moderate", "Heavy", "Very heavy"];

/** WBGT band → work/rest split per workload, as "work/rest" minutes in each hour. */
const ROWS: { band: string; splits: string[] }[] = [
  { band: "up to 30 °C", splits: ["60 / 0", "60 / 0", "60 / 0", "45 / 15"] },
  { band: "30 – 31 °C", splits: ["60 / 0", "60 / 0", "45 / 15", "30 / 30"] },
  { band: "31 – 32 °C", splits: ["60 / 0", "45 / 15", "30 / 30", "20 / 40"] },
  { band: "32 – 33 °C", splits: ["45 / 15", "30 / 30", "20 / 40", "rest"] },
  { band: "above 33 °C", splits: ["30 / 30", "20 / 40", "rest", "rest"] },
];

export default function NioshWbgtPanel() {
  return (
    <section>
      <h2 className="text-[12px] font-bold uppercase tracking-wider text-cool-300 mb-1">
        NIOSH WBGT work/rest guidance
      </h2>
      <p className="text-[13px] text-ink-400 mb-4 leading-relaxed">
        The occupational standard for working in heat. Wet-bulb globe temperature accounts for
        humidity, radiant heat and air movement rather than air temperature alone, and the
        recommended split between work and rest tightens as it climbs and as the work gets harder.
      </p>

      <div className="glass rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-ink-400">
                <th className="p-3 font-bold">WBGT</th>
                {WORKLOADS.map((w) => (
                  <th key={w} className="p-3 font-bold whitespace-nowrap">
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.band} className="border-t border-white/[0.06]">
                  <td className="p-3 text-[12.5px] text-ink-200 whitespace-nowrap">{r.band}</td>
                  {r.splits.map((s, i) => (
                    <td
                      key={`${r.band}-${WORKLOADS[i]}`}
                      className={`p-3 text-[12.5px] tabular whitespace-nowrap ${s === "rest" ? "text-ink-500" : "text-ink-200"}`}
                    >
                      {s}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 text-[10.5px] text-ink-500 border-t border-white/[0.06]">
          Illustrative, rounded work/rest minutes per hour. The published criteria vary with
          acclimatisation, clothing and metabolic rate — refer to NIOSH for the authoritative values.
        </div>
      </div>

      <p className="text-[12.5px] text-ink-300 mt-3 leading-relaxed">
        Our accumulator&apos;s thresholds are designed to align with NIOSH WBGT work/rest guidance as
        a future calibration target.
      </p>
    </section>
  );
}
