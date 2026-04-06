"use client";

import { useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import SubmissionInbox from "../../components/governance/SubmissionInbox";
import SubmitForm from "../../components/governance/SubmitForm";
import SystemState from "../../components/governance/SystemState";

export default function GovernancePage() {
  const { data: session, status } = useSession();
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSubmitted = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <span className="text-zinc-500 text-sm">Loading...</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <span className="text-zinc-500 text-sm">Sign in to access governance</span>
      </div>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Governance Inbox</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Review submissions, audit results, and board decisions
          </p>
        </div>
        <SubmitForm onSubmitted={handleSubmitted} />
      </div>
      <SubmissionInbox key={refreshKey} />
      <SystemState />
    </main>
  );
}
