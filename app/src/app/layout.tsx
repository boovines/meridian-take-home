import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Meridian · Process studio",
  description:
    "Map a process, resolve the unknowns, and build a dependable agent.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
