"use client";

import Script from "next/script";
import { useEffect } from "react";

export function HomeMotion() {
  useEffect(() => () => { window.dispatchEvent(new Event("pixel-studio:leave-home")); }, []);
  return <Script type="module" src="/assets/studio-home.js" onReady={() => { window.dispatchEvent(new Event("pixel-studio:home")); }} />;
}
