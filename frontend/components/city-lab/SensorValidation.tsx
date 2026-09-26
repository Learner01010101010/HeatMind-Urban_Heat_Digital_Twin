"use client";

import { Download, FlaskConical, Loader2, Upload } from "lucide-react";
import { useState } from "react";
import { AREAS, cityLabApi, downloadText, predictionTemplate, validationCsv, type LabArea, type TemperatureMetric, type ValidationResult } from "@/lib/cityLabApi";
import { Stat, ValidationPlot } from "./LabVisuals";

const METRICS: Record<TemperatureMetric, string> = { surface_c: "Surface temperature · IR readings", air_c: "Air temperature · thermometer", feels_c: "Feels-like · comparable derived metric" };
export default function SensorValidation() {
  const [area, setArea] = useState<LabArea>("narhe");
  const [metric, setMetric] = useState<TemperatureMetric>("surface_c");
  const [tolerance, setTolerance] = useState(2);
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [edited, setEdited] = useState(false);

  const run = async (demo: boolean) => {
    setBusy(true); setError("");
    try { setResult(await (demo ? cityLabApi.demo(area, metric, tolerance) : cityLabApi.validate(csv, tolerance))); setEdited(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not compare the readings."); }
    finally { setBusy(false); }
  };
  const template = async () => {
    setBusy(true); setError("");
    try {
      const data = await cityLabApi.catalog(area, "live");
      downloadText("heatmind-live-prediction-template.csv", predictionTemplate(data, metric));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create a prediction template."); }
    finally { setBusy(false); }
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 60000) { setError("Choose a CSV under 60 KB with at most 60 readings."); return; }
    try { setCsv(await file.text()); setEdited(!!result); setError(""); }
    catch { setError("Could not read this file. Paste the CSV instead."); }
  };

  return <div className="space-y-5">
    <div className="rounded-2xl border border-[#a9d7fa]/20 bg-[#a9d7fa]/5 p-4 text-sm text-ink-200"><strong className="text-[#a9d7fa]">How close are predictions to readings?</strong> Compare the same temperature metric at matching places and times. See the errors directly, without recalibrating the twin.</div>
    <div className="grid lg:grid-cols-[340px_1fr] gap-5 items-start">
      <aside className="glass rounded-3xl p-5 space-y-4 order-last lg:order-first">
        <div className="flex gap-2 items-center"><FlaskConical size={18} className="text-[#a9d7fa]" /><h2 className="font-semibold">Validation inputs</h2></div>
        <label className="block text-xs text-ink-300">Neighbourhood for demo / template<select value={area} aria-label="Validation neighbourhood" disabled={busy} onChange={(e) => { setArea(e.target.value as LabArea); setEdited(!!result); }} className="mt-2 w-full rounded-xl bg-ink-800 p-3 text-sm text-ink-100">{Object.entries(AREAS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        <label className="block text-xs text-ink-300">Temperature metric for demo / template<select aria-label="Validation temperature metric" value={metric} disabled={busy} onChange={(e) => { setMetric(e.target.value as TemperatureMetric); setEdited(!!result); }} className="mt-2 w-full rounded-xl bg-ink-800 p-3 text-sm text-ink-100">{Object.entries(METRICS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        <label className="block text-xs text-ink-300">Comparison tolerance · ±{tolerance.toFixed(1)}°C<input aria-label="Comparison tolerance" type="range" min="0.5" max="5" step="0.5" value={tolerance} disabled={busy} onChange={(e) => { setTolerance(Number(e.target.value)); setEdited(!!result); }} className="block w-full mt-3 accent-[#a9d7fa]" /><span className="text-[10px] text-ink-400">A chosen error threshold, not a safety threshold.</span></label>
        <button disabled={busy} onClick={() => void run(true)} className="w-full rounded-xl bg-[#a9d7fa] text-ink-950 p-3 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-40">{busy ? <Loader2 size={15} className="animate-spin" /> : <FlaskConical size={15} />}Load synthetic demo</button>
        <p className="text-[11px] text-[#ffc48a]">Demo readings are generated from predictions plus known offsets. They demonstrate the interface and do not prove model accuracy.</p>
        <div className="border-t border-white/10 pt-4 space-y-3"><h3 className="text-sm font-medium">Use your own readings</h3><p className="text-[11px] text-ink-400 leading-relaxed">Download a live prediction snapshot, collect the matching observations, then fill <code>observed_c</code> and upload it. Keep the timestamp and temperature metric unchanged.</p>
          <button disabled={busy} onClick={() => void template()} className="w-full rounded-xl border border-white/10 p-3 text-xs flex items-center justify-center gap-2 disabled:opacity-40"><Download size={14} />Download live prediction template</button>
          <label className="block text-xs text-ink-300">Import CSV<input type="file" accept=".csv,text/csv" aria-label="Import sensor readings CSV" disabled={busy} onChange={(e) => void readFile(e.target.files?.[0])} className="mt-2 block w-full text-[11px] file:rounded-lg file:border-0 file:bg-white/10 file:p-2 file:mr-2 file:text-ink-200" /></label>
          <label className="block text-xs text-ink-300">Or paste CSV<textarea aria-label="Sensor readings CSV" value={csv} maxLength={60000} disabled={busy} onChange={(e) => { setCsv(e.target.value); setEdited(!!result); }} placeholder="lat,lon,time,metric,observed_c,predicted_c" className="mt-2 w-full min-h-28 rounded-xl bg-ink-800 p-3 font-mono text-[10px]" /></label>
          <button disabled={busy || !csv.trim()} onClick={() => void run(false)} className="w-full rounded-xl bg-white/10 p-3 font-semibold text-sm flex justify-center items-center gap-2 disabled:opacity-40"><Upload size={15} />Compare uploaded readings</button>
          <details className="text-[10px] text-ink-400"><summary className="cursor-pointer">CSV format and matching rules</summary><p className="mt-2 leading-relaxed">Required: lat, lon, time, metric, observed_c. Optional: predicted_c, label. Time must include a timezone; metric is surface_c, air_c or feels_c. Up to 60 unique readings inside the modelled zone. Use one metric per file.</p><p className="mt-2 leading-relaxed">Without predicted_c, the backend reconstructs the twin for the last 24 hours using available weather. Older readings require saved predictions. Air measurements must not be compared with surface or feels-like predictions.</p></details>
        </div>
      </aside>
      <div className="space-y-4 min-w-0 order-first lg:order-last">
        <button disabled={busy} onClick={() => void run(true)} className="lg:hidden w-full rounded-xl bg-[#a9d7fa] text-ink-950 p-3 text-sm font-semibold disabled:opacity-40">{busy ? "Comparing…" : "Load synthetic demo"}</button>
        {error && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
        {result ? <>
          <div className={`rounded-2xl border p-4 ${result.source === "synthetic_demo" ? "border-[#ffc48a]/25 bg-[#ffc48a]/5" : "border-[#a9d7fa]/25 bg-[#a9d7fa]/5"}`}><div className="text-xs font-semibold uppercase tracking-wider" style={{ color: result.source === "synthetic_demo" ? "#ffc48a" : "#a9d7fa" }}>{result.source === "synthetic_demo" ? "Synthetic demo · not field validation" : "Uploaded observations · supplied by you"}</div><p className="mt-2 text-xs text-ink-300 leading-relaxed">{result.note}</p></div>
          {edited && <p role="status" className="text-xs text-[#ffc48a]">Inputs changed. Load the demo or compare the CSV again to update the displayed results.</p>}
          <div className="flex items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">{result.metric_label}</h2><p className="text-xs text-ink-400 mt-1">{result.stats.count} paired readings · errors = predicted − observed</p></div><button onClick={() => downloadText(result.source === "synthetic_demo" ? "heatmind-synthetic-demo-results.csv" : "heatmind-observation-comparison.csv", validationCsv(result))} className="inline-flex gap-1.5 items-center text-xs text-ink-300"><Download size={14} />Export</button></div>
          <ValidationPlot result={result} />
          <div className="flex flex-wrap gap-4 text-[10px] text-ink-300"><span><span className="text-[#a9d7fa]">●</span> Within ±{result.tolerance_c}°C</span><span><span className="text-[#ffc48a]">●</span> Outside chosen tolerance</span></div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Mean absolute error" value={`${result.stats.mae_c.toFixed(2)}°C`} hint="Typical size of prediction error" color="#a9d7fa" />
            <Stat label="Root mean square error" value={`${result.stats.rmse_c.toFixed(2)}°C`} hint="Gives larger errors more weight" />
            <Stat label="Average bias" value={`${result.stats.bias_c > 0 ? "+" : ""}${result.stats.bias_c.toFixed(2)}°C`} hint={Math.abs(result.stats.bias_c) < .005 ? "No average warm / cool bias in this sample" : result.stats.bias_c > 0 ? "Predictions run warmer on average" : "Predictions run cooler on average"} />
            <Stat label={`Within ±${result.tolerance_c}°C`} value={`${result.stats.within_tolerance_pct.toFixed(0)}%`} hint="Share within your chosen tolerance" color="#8ad8b0" />
          </div>
          <div className="rounded-2xl border border-white/10 overflow-x-auto"><table className="w-full min-w-[520px] text-xs text-left"><caption className="text-left p-3 text-ink-300">Paired readings · predictions and observations use the same metric</caption><thead className="text-ink-400 border-y border-white/10"><tr><th className="p-3">Location</th><th className="p-3">Observed</th><th className="p-3">Predicted</th><th className="p-3">Error</th></tr></thead><tbody>{result.rows.map((r, i) => <tr key={i} className="border-b border-white/5"><td className="p-3"><div className="max-w-[230px] break-words">{r.label}</div><div className="text-[9px] text-ink-400 mt-1">{new Date(r.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} IST</div><div className="text-[9px] text-ink-400">{r.reference_source === "twin_reconstruction" ? "Reconstructed twin reference" : result.source === "synthetic_demo" ? "Generated demo pair" : "Reference supplied in CSV"}</div></td><td className="p-3 tabular">{r.observed_c.toFixed(1)}°C</td><td className="p-3 tabular">{r.predicted_c.toFixed(1)}°C</td><td className="p-3 tabular" style={{ color: Math.abs(r.error_c) <= result.tolerance_c ? "#a9d7fa" : "#ffc48a" }}>{r.error_c > 0 ? "+" : ""}{r.error_c.toFixed(1)}°C</td></tr>)}</tbody></table></div>
        </> : <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-8 md:p-12 min-h-[350px] flex flex-col justify-center items-start"><FlaskConical size={32} className="text-[#a9d7fa] mb-5" /><h2 className="text-2xl font-semibold">Show the evidence behind the twin</h2><p className="text-sm text-ink-300 mt-3 max-w-md leading-relaxed">Load a synthetic demonstration to explore the chart, or import real paired observations. Every point shows how far a prediction is from the reading.</p><div className="mt-6 flex gap-3 flex-wrap text-xs"><span className="rounded-full bg-white/5 px-3 py-2">Prediction vs observation</span><span className="rounded-full bg-white/5 px-3 py-2">Error metrics</span><span className="rounded-full bg-white/5 px-3 py-2">Exportable evidence</span></div></div>}
      </div>
    </div>
  </div>;
}
