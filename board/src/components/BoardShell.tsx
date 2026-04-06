"use client";

import { ReactNode } from "react";
import SideNav from "@/components/SideNav";
import ChatPanel from "@/components/ChatPanel";
import PanelLayout from "@/components/PanelLayout";

/**
 * BoardShell: 3-panel IDE-like layout.
 * Left: SideNav (navigation + controls)
 * Center: Page content (Next.js children)
 * Right: ChatPanel (persistent chat with history)
 */
export default function BoardShell({ children }: { children: ReactNode }) {
  return (
    <PanelLayout
      left={<SideNav />}
      center={<main className="h-full overflow-y-auto">{children}</main>}
      right={<ChatPanel />}
    />
  );
}
