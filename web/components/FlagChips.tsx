import type { Flag } from "../lib/api";
import { humanizeRule } from "../lib/format";

export function FlagChips({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return <span className="faint">—</span>;
  return (
    <>
      {flags.map((f) => (
        <span key={f.ruleId} className={`flag flag-${f.severity === "warn" ? "warn" : "info"}`} title={f.reason}>
          {humanizeRule(f.ruleId)}
        </span>
      ))}
    </>
  );
}
