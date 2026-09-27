/**
 * Print the addresses a phone on the same Wi-Fi can open.
 *
 * Next already binds 0.0.0.0 and prints a "Network:" line, but it prints it
 * after a build that can take several seconds, it picks one interface, and it
 * says nothing about the two things that actually stop a phone connecting: the
 * Windows firewall prompt, and the fact that the browser will not hand out GPS
 * over plain http to anything that is not localhost.
 */
import { networkInterfaces } from "node:os";

const https = process.argv.includes("--https");
const port = process.env.PORT || "3000";
const scheme = https ? "https" : "http";

const addresses = Object.entries(networkInterfaces())
  .flatMap(([name, list]) => (list ?? []).map((entry) => ({ ...entry, name })))
  .filter((entry) => entry.family === "IPv4" && !entry.internal)
  // Link-local addresses mean DHCP did not answer; they will not route.
  .filter((entry) => !entry.address.startsWith("169.254."));

const line = "─".repeat(58);
console.log(`\n${line}`);
if (!addresses.length) {
  console.log("  No network interface found. Connect to Wi-Fi and try again.");
} else {
  console.log("  Open on a phone connected to the SAME Wi-Fi:\n");
  for (const { address, name } of addresses) {
    console.log(`    ${scheme}://${address}:${port}    (${name})`);
  }
}

if (https) {
  console.log("\n  The certificate is self-signed, so the phone will warn once.");
  console.log("  Accept it to continue. HTTPS is what lets the browser share GPS");
  console.log("  with a page that is not on localhost.");
} else {
  console.log("\n  Plain http: the map, routing and the trip simulation all work,");
  console.log("  but the browser will refuse to share real GPS with a page that is");
  console.log("  not on localhost. Use `npm run dev:mobile` for that.");
}
console.log("\n  If the phone cannot connect, allow Node through the firewall");
console.log("  for private networks, and check the laptop is not on a guest SSID");
console.log("  that isolates clients from each other.");
console.log(`${line}\n`);
