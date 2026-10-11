"use client";

/* <DesignToolkit /> for React apps (Next.js, Vite, Remix): drop it into the root layout once.
   It loads the toolbar in the browser during development and renders nothing, so production builds
   never run it. */
import { useEffect } from "react";

const isDev = () => typeof process === "undefined" || process.env.NODE_ENV !== "production";

export function DesignToolkit() {
  useEffect(() => {
    if (isDev()) import("./toolkit.js");
  }, []);
  return null;
}

export default DesignToolkit;
