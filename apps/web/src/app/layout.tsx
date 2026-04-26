import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Modpack Compatibility Checker",
  description: "Check Minecraft mod compatibility before installing.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
