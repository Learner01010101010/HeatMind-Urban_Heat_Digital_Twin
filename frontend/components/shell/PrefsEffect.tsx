"use client";

import { useEffect } from "react";
import { startClock, usePrefs } from "@/lib/store";

/** Mirrors accessibility prefs onto <html> (senior mode = larger type/targets, reduced motion). */
export default function PrefsEffect() {
  useEffect(() => {
    void usePrefs.persist.rehydrate();
    startClock(); // live wall clock for the whole app
  }, []);
  const senior = usePrefs((s) => s.seniorMode);
  const reduce = usePrefs((s) => s.reduceMotion);
  useEffect(() => {
    document.documentElement.classList.toggle("senior", senior);
    document.documentElement.classList.toggle("reduce-motion", reduce);
  }, [senior, reduce]);
  return null;
}
