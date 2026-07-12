import { useState, useEffect } from "react";
import { useOpendSettings, usePutOpendSettings } from "../lib/hooks";
import { DEFAULT_OPEND_PORT } from "../lib/constants";

/** OpenD connection settings — where a non-technical user points the app at their local OpenD gateway
 * (WebSocket key + port). The config DB is the single source of truth (no environment variables). The
 * key is write-only: the server only tells us whether one is saved, never the value, so the field
 * stays blank with "leave blank to keep". */
export function Settings() {
  const { data, isLoading } = useOpendSettings();
  const save = usePutOpendSettings();
  const [port, setPort] = useState(String(DEFAULT_OPEND_PORT));
  const [key, setKey] = useState("");
  const [seeded, setSeeded] = useState(false);

  // Seed the port field once from the server (don't clobber the user's edits on a background refetch).
  useEffect(() => {
    if (!data || seeded) return;
    setPort(String(data.port));
    setSeeded(true);
  }, [data, seeded]);

  if (isLoading || !data) return <div className="spinner">Loading…</div>;

  const portNum = Number(port);
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const trimmedKey = key.trim();
  const portDirty = portValid && String(portNum) !== String(data.port);
  const keyDirty = trimmedKey.length > 0;
  const dirty = portValid && (portDirty || keyDirty);

  const submit = () => {
    if (!dirty) return;
    const body: { key?: string; port?: number } = {};
    if (portDirty) body.port = portNum;
    if (keyDirty) body.key = trimmedKey;
    save.mutate(body, { onSuccess: () => setKey("") });
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>OpenD connection</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            Trade Review syncs through the FUTU <strong>OpenD</strong> gateway running on your computer.
            Enter the WebSocket key you set in OpenD and the port it listens on. Your key is stored
            locally on this machine and never leaves it.
          </p>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>OpenD port</span>
          <input
            className="input"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder={String(DEFAULT_OPEND_PORT)}
          />
          {!portValid && <span className="neg" style={{ fontSize: 12 }}>Enter a port between 1 and 65535.</span>}
          <span className="faint" style={{ fontSize: 12 }}>Default is {DEFAULT_OPEND_PORT}.</span>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>OpenD WebSocket key</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={data.hasKey ? "•••••••• saved — leave blank to keep" : "Paste your OpenD key"}
          />
          <span className="faint" style={{ fontSize: 12 }}>
            {data.hasKey
              ? "A key is saved. Type a new one only to replace it."
              : "No key saved yet — syncing needs this."}
          </span>
        </label>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn btn-primary" onClick={submit} disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {save.isSuccess && !dirty && <span className="pos" style={{ fontSize: 13 }}>Saved.</span>}
          {save.isError && (
            <span className="neg" style={{ fontSize: 13 }}>
              {save.error instanceof Error ? save.error.message : "Save failed."}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
