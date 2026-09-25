import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import EmergencySheet from "@/components/hud/EmergencySheet";
import GlobalNav from "@/components/shell/GlobalNav";
import PrefsEffect from "@/components/shell/PrefsEffect";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "HeatMind AI · Urban Heat Digital Twin",
  description: "A living digital twin of a city's heat — street by street, minute by minute, person by person. Narhe to Swargate, Pune.",
  applicationName: "HeatMind AI",
};

export const viewport: Viewport = {
  themeColor: "#060606",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <PrefsEffect />
        {children}
        <GlobalNav />
        {/* Mounted beside the nav rather than inside the map page: the Emergency
            button is on every screen, so the sheet it opens has to be too. */}
        <EmergencySheet />
      </body>
    </html>
  );
}
