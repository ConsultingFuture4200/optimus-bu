export async function opsFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`/api/ops?path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export type OpsPostResult<T> = {
  ok: true;
  data: T;
} | {
  ok: false;
  error: string;
}

export async function opsPatch<T>(path: string, body?: unknown): Promise<OpsPostResult<T>> {
  try {
    const res = await fetch("/api/ops", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, body }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Request failed" }));
      return { ok: false, error: err.error || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Backend unreachable" };
  }
}

export async function opsPost<T>(path: string, body?: unknown): Promise<OpsPostResult<T>> {
  try {
    const res = await fetch("/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, body }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Request failed" }));
      return { ok: false, error: err.error || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Backend unreachable" };
  }
}

export async function opsDelete<T>(path: string): Promise<OpsPostResult<T>> {
  try {
    const res = await fetch("/api/ops", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Request failed" }));
      return { ok: false, error: err.error || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Backend unreachable" };
  }
}
