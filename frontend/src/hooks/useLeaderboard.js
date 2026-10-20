import { useCallback, useEffect, useState } from "react";

// Keep each response attached to the exact filters that requested it.
export default function useLeaderboard({ active, sortBy, period, mode, order, revision }) {
  const [state, setState] = useState({ rows: [], error: false, loading: false, updatedAt: null, hasNext: false });
  const [pagination, setPagination] = useState({ key: "", page: 0 });
  const filterKey = `${sortBy}:${period}:${mode}:${order}`;
  const page = pagination.key === filterKey ? pagination.page : 0;
  const setPage = (value) => setPagination({ key: filterKey, page: Math.max(0, value) });
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    if (!active) return undefined;
    const params = new URLSearchParams({ sort_by: sortBy, period, mode, order, limit: "51", offset: String(page * 50) });
    let disposed = false;
    let requestId = 0;
    let controller;
    let timer;
    setState({ rows: [], error: false, loading: true, updatedAt: null, hasNext: false });

    const fetchRows = async () => {
      const id = ++requestId;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/leaderboard?${params}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("leaderboard");
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error("invalid leaderboard");
        if (!disposed && id === requestId) {
          setState({ rows: rows.slice(0, 50), hasNext: rows.length > 50, error: false, loading: false, updatedAt: new Date() });
        }
      } catch (error) {
        if (!disposed && id === requestId && error.name !== "AbortError") {
          setState((previous) => ({ ...previous, error: true, loading: false }));
        }
      } finally {
        if (!disposed && id === requestId) timer = window.setTimeout(fetchRows, 15000);
      }
    };
    void fetchRows();
    return () => {
      disposed = true;
      requestId += 1;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [active, sortBy, period, mode, order, revision, refreshToken, page]);

  return { ...state, refresh, page, setPage };
}
