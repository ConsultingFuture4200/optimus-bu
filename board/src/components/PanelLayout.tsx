"use client";

/**
 * Three-panel resizable layout (Cursor/VS Code style).
 *
 * Left: SideNav (collapsible)
 * Center: Main content (pages)
 * Right: Chat panel (collapsible)
 *
 * Uses react-resizable-panels (Group/Panel/Separator).
 */

import { ReactNode } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";

interface PanelLayoutProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

export default function PanelLayout({ left, center, right }: PanelLayoutProps) {
  return (
    <div className="flex-1 min-h-0">
      {/* Desktop: 3-panel */}
      <div className="hidden md:flex h-full">
        <Group orientation="horizontal">
          {/* Left: SideNav */}
          <Panel
            id="nav"
            defaultSize="15%"
            minSize="52px"
            maxSize="25%"
            collapsible
            collapsedSize="52px"
          >
            <div className="h-full overflow-hidden">{left}</div>
          </Panel>

          <Separator className="group relative flex items-center justify-center w-[6px] hover:w-[8px] transition-all">
            <div className="absolute inset-y-0 w-px bg-white/5 group-hover:bg-white/15 group-data-[resize-handle-active]:bg-emerald-500/40 transition-colors" />
          </Separator>

          {/* Center: Main content */}
          <Panel id="main" defaultSize="55%" minSize="30%">
            <div className="h-full overflow-hidden">{center}</div>
          </Panel>

          <Separator className="group relative flex items-center justify-center w-[6px] hover:w-[8px] transition-all">
            <div className="absolute inset-y-0 w-px bg-white/5 group-hover:bg-white/15 group-data-[resize-handle-active]:bg-emerald-500/40 transition-colors" />
          </Separator>

          {/* Right: Chat */}
          <Panel
            id="chat"
            defaultSize="30%"
            minSize="250px"
            maxSize="50%"
            collapsible
            collapsedSize="0px"
          >
            <div className="h-full overflow-hidden border-l border-white/5">{right}</div>
          </Panel>
        </Group>
      </div>

      {/* Mobile: single column */}
      <div className="md:hidden flex flex-col h-full">
        <main className="flex-1 overflow-y-auto">{center}</main>
      </div>
    </div>
  );
}
