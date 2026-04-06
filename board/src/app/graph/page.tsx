"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Redirect /graph → /agents?tab=graph
export default function GraphRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/agents?tab=graph"); }, [router]);
  return <div className="p-4 text-zinc-500 text-sm">Redirecting to Agents Hub...</div>;
}
