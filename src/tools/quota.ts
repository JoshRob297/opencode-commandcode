import { fetchQuotaData, type QuotaData } from "../client/api.ts";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMin = Math.round(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  let res = "";
  if (d > 0) res += `${d}d `;
  if (h > 0 || d > 0) res += `${h}h `;
  res += `${m}m`;
  return res.trim();
}

export function drawBar(pct: number): string {
  const p = Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)));
  const filled = Math.round(p / 10);
  const empty = 10 - filled;
  return "[" + "#".repeat(filled) + "-".repeat(empty) + `] ${p}%`;
}

function pct(used?: number, cap?: number): number {
  if (!cap || !Number.isFinite(cap) || cap <= 0) return 0;
  const u = Number.isFinite(used as number) ? (used as number) : 0;
  return Math.max(0, Math.min(100, (u / cap) * 100));
}

export function formatQuotaReport(data: QuotaData): string {
  const now = Date.now();
  const { fiveHour, weekly } = data;

  const fiveHourReset = fiveHour?.resetAt ? formatDuration(fiveHour.resetAt - now) : "N/A";
  const weeklyReset = weekly?.resetAt ? formatDuration(weekly.resetAt - now) : "N/A";

  const lines: string[] = [
    "=================================================",
    `COMMAND CODE QUOTA & USAGE (${data.user})`,
    `Plan: ${String(data.plan).toUpperCase()} | Estado: ${String(data.status).toUpperCase()} | Renueva: ${data.periodEnd}`,
    "-------------------------------------------------",
    `Creditos Mensuales Restantes: $${(data.monthlyRemaining ?? 0).toFixed(2)} USD`,
  ];

  if ((data.purchasedCredits ?? 0) > 0) {
    lines.push(`Creditos Extra / Recargas:    $${data.purchasedCredits.toFixed(2)} USD`);
  }

  lines.push("-------------------------------------------------");
  lines.push("VENTANAS DE RITMO (RATE LIMITS):");

  if (fiveHour) {
    lines.push(
      ` Ventana 5 Horas: ${drawBar(pct(fiveHour.used, fiveHour.cap))} ($${fiveHour.used.toFixed(4)} / $${fiveHour.cap.toFixed(2)}) -> Resetea en: ${fiveHourReset}`
    );
  } else {
    lines.push(" Ventana 5 Horas: N/D");
  }

  if (weekly) {
    lines.push(
      ` Ventana Semanal: ${drawBar(pct(weekly.used, weekly.cap))} ($${weekly.used.toFixed(4)} / $${weekly.cap.toFixed(2)}) -> Resetea en: ${weeklyReset}`
    );
  } else {
    lines.push(" Ventana Semanal: N/D");
  }

  lines.push("-------------------------------------------------");
  if (data.summary) {
    lines.push("CONSUMO ACUMULADO DEL CICLO:");
    lines.push(
      ` Peticiones Totales: ${data.summary.totalCount} (Exitosas: ${data.summary.completedCount}, Fallidas: ${data.summary.failedCount})`
    );
    lines.push(
      ` Tokens Totales:     ${data.summary.totalTokens} (Prompt: ${data.summary.totalTokensIn}, Completions: ${data.summary.totalTokensOut})`
    );
    lines.push(` Gasto Total:        $${(data.summary.totalCost ?? 0).toFixed(6)} USD`);
  }
  lines.push("=================================================");

  return lines.join("\n");
}

export async function getQuotaReport(opts: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const data = await fetchQuotaData(opts);
    return formatQuotaReport(data);
  } catch (err: any) {
    return `Error consultando Command Code: ${err?.message ?? String(err)}`;
  }
}
