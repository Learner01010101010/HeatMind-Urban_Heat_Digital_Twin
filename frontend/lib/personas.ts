import { Bike, GraduationCap, HardHat, HeartPulse, Package } from "lucide-react";
import type { Persona } from "./api";

export const PERSONAS: { id: Persona; label: string; icon: React.ElementType; blurb: string; accent: string }[] = [
  { id: "student", label: "Student", icon: GraduationCap, blurb: "Short walks between classes, many times a day.", accent: "#4cc3ff" },
  { id: "worker", label: "Outdoor Worker", icon: HardHat, blurb: "Hours outside with exertion and few breaks.", accent: "#fb8a1f" },
  { id: "senior", label: "Senior", icon: HeartPulse, blurb: "Slower pace — heat hits harder, sooner.", accent: "#f472b6" },
  { id: "cyclist", label: "Cyclist", icon: Bike, blurb: "Faster trips, close to radiating asphalt.", accent: "#a3e635" },
  { id: "gig_worker", label: "Delivery Rider", icon: Package, blurb: "Full shifts outside on two wheels — pay tied to trips, not rest.", accent: "#dd1367" },
];

export const personaOf = (id: Persona) => PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];
