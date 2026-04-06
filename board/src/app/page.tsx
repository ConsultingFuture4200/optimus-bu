"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import ChatSurface from "@/components/ChatSurface";
import { usePageContext } from "@/contexts/PageContext";

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { currentPage } = usePageContext();
  const sessionId = searchParams.get("session");

  const handleSessionChange = (id: string | null) => {
    if (id) {
      router.push(`/?session=${id}`);
    } else {
      router.push("/");
    }
  };

  return (
    <ChatSurface
      sessionId={sessionId}
      onSessionChange={handleSessionChange}
      pageContext={currentPage}
    />
  );
}

export default function Home() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}
