import type { Flag } from "../lib/api";
import { flagDef } from "../../src/domain/flag-defs";

/** One flag chip: registry title as the label, with a hover tooltip that explains what the flag
 * means (summary), what happened on this trade (reason), and why it matters (why). */
export function FlagChips({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return <span className="faint">—</span>;
  return (
    <>
      {flags.map((f) => {
        const def = flagDef(f.ruleId);
        const tip = [def.summary, f.reason, def.why && `Why: ${def.why}`]
          .filter(Boolean)
          .join("\n\n");
        return (
          <span
            key={f.ruleId}
            className={`flag flag-${f.severity === "warn" ? "warn" : "info"}`}
            title={tip}
          >
            {def.title}
          </span>
        );
      })}
    </>
  );
}
