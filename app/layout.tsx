import "./globals.css";
import type { Metadata } from "next";
import { Fraunces, Inter, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { SimpleModeProvider, SimpleToggle } from "./components/SimpleMode";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Atelier — loops with tools",
  description: "Give it a goal; it moves through prompt-driven states. The AI uses tools, you approve.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} ${geistMono.variable}`}>
      <body>
        {/* Set the mode on <html> BEFORE first paint so simple-mode chrome doesn't flash the Pro bar. */}
        <script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.simple=localStorage.getItem('atelier-simple')==='1'?'1':''}catch(e){}" }} />
        <SimpleModeProvider>
          <header className="topbar">
            <Link href="/" className="brand"><b>Atelier</b></Link>
            <nav className="topnav">
              <Link href="/">Board</Link>
              <Link href="/machines">Loops</Link>
            </nav>
            <SimpleToggle />
          </header>
          <main className="page">{children}</main>
        </SimpleModeProvider>
      </body>
    </html>
  );
}
