"use client";

import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import type { CollisionDetection } from "@dnd-kit/core";
import { apiGet, apiPost, apiPut } from "../lib/api";
import { localDateStr } from "../lib/datetime";
import { notify } from "@/lib/toast";
import { format, addDays, subDays, parseISO, startOfWeek, isToday } from "date-fns";
import { it } from "date-fns/locale";

import StoricoPiani from "./components/StoricoPiani";
import WODetailDrawer from "./components/WODetailDrawer";
import ReplanModal from "./components/ReplanModal";
import SchedulingSummaryModal from "./components/SchedulingSummaryModal";

import type {
  TicketData,
  TecnicoData,
  PlannedWO,
  GeneratedPlan,
  EfficiencyBreakdown,
  SchedulingSummary,
} from "./types";
import { tipoStyle } from "./types";

// ─── Tipi ─────────────────────────────────────────────────────────────────────

type ViewMode = "day" | "week" | "2week";

interface TecnicoAPI {
  id: number;
  nome: string;
  cognome: string | null;
  skill: string;
  ore_giornaliere: number;
  orario_inizio: string;
  orario_fine: string;
  stato: string;
  assenza_corrente?: TecnicoData["assenza_corrente"];
}

import { createContext, useContext } from "react";
import { useT, tn } from "@/app/lib/i18n";
import { labelPriorita } from "@/app/lib/i18n/domain";

// ─── Costanti Gantt ───────────────────────────────────────────────────────────

const DAY_START_H = 7;
const DAY_END_H = 19;
const BASE_HOUR_W = 80;
const BASE_DAY_W = 156;
const BASE_ROW_H = 82;
const LABEL_W = 272;

const ZoomContext = createContext<number>(1);
function useZoom() { return useContext(ZoomContext); }

const PRIO_COLORS: Record<string, string> = {
  Alta: "#ef4444",
  Media: "#f59e0b",
  Bassa: "#22c55e",
};

// Riferimento stabile per i tecnici senza ticket (evita re-render delle righe memoizzate)
const EMPTY_TICKETS: TicketData[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDays(base: Date, view: ViewMode): Date[] {
  if (view === "day") return [base];
  const mon = startOfWeek(base, { weekStartsOn: 1 });
  const count = view === "week" ? 7 : 14;
  return Array.from({ length: count }, (_, i) => addDays(mon, i));
}

function parseStart(ticket: TicketData): { date: string; hour: number; minute: number } | null {
  if (!ticket.planned_start) return null;
  try {
    const d = parseISO(ticket.planned_start);
    return { date: format(d, "yyyy-MM-dd"), hour: d.getHours(), minute: d.getMinutes() };
  } catch {
    return null;
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function planDateTime(dateStr: string, timeStr?: string | null): string {
  const time = (timeStr || "08:00").split(":").slice(0, 2).join(":");
  return `${dateStr}T${time}:00`;
}

function ticketHours(ticket: TicketData | null | undefined): number {
  return Math.max(0.5, Number(ticket?.durata_stimata_ore) || 1);
}

// ─── Helpers sovrapposizione orari ───────────────────────────────────────────
// Intervalli occupati (in ore decimali) per un tecnico in una data, considerando
// sia gli interventi dove è principale sia quelli dove è di supporto.
function busyIntervalsForTecnico(
  tickets: TicketData[],
  tecnicoId: number,
  date: string,
  excludeTicketId: number,
): Array<[number, number]> {
  const res: Array<[number, number]> = [];
  for (const t of tickets) {
    if (t.id === excludeTicketId) continue;
    if (t.is_support) continue; // evita doppio conteggio: le copie supporto derivano dall'originale
    const isPrimary = t.tecnico_id === tecnicoId;
    const isSupport = t.tecnico_supporto_id === tecnicoId;
    if (!isPrimary && !isSupport) continue;
    const p = parseStart(t);
    if (!p || p.date !== date) continue;
    const start = p.hour + p.minute / 60;
    res.push([start, start + ticketHours(t)]);
  }
  return res;
}

function intervalsOverlap(intervals: Array<[number, number]>, start: number, end: number): boolean {
  return intervals.some(([s, e]) => start < e - 1e-6 && end > s + 1e-6);
}

// Primo orario utile (ore decimali) in cui un intervento di durata `dur` entra senza
// sovrapporsi, all'interno della giornata lavorativa. Ritorna null se non c'è spazio.
function firstFreeSlot(
  intervals: Array<[number, number]>,
  dur: number,
  dayStart = DAY_START_H,
  dayEnd = DAY_END_H,
  minStart = DAY_START_H,
): number | null {
  const start0 = Math.max(dayStart, minStart);
  for (let t = start0; t + dur <= dayEnd + 1e-9; t += 0.5) {
    if (!intervalsOverlap(intervals, t, t + dur)) return t;
  }
  return null;
}

function decToHHMM(dec: number): string {
  const h = Math.floor(dec);
  const m = Math.round((dec - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function hhmmToDec(s: string): number {
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  return (h || 0) + (m || 0) / 60;
}

function isTecnicoOperativo(tecnico: TecnicoData, dataToCheck?: string): boolean {
  // Se viene fornita una data specifica, controlla ESCLUSIVAMENTE le assenze per quella data.
  // Ignora lo "stato" globale che potrebbe essere riferito solo ad oggi (es. "Ferie").
  if (dataToCheck) {
    if (!tecnico.assenze) return true;
    return !tecnico.assenze.some(a => {
      if (!a.data_inizio || !a.data_fine) return false;
      const start = a.data_inizio.split("T")[0];
      const end = a.data_fine.split("T")[0];
      return dataToCheck >= start && dataToCheck <= end;
    });
  }
  
  // Senza data specifica, consideriamo solo se ha un'assenza corrente o meno.
  // Non controlliamo lo string match di "tecnico.stato" per evitare falsi negativi sulle righe intere.
  return !tecnico.assenza_corrente;
}

function plannedDate(ticket: TicketData): string | null {
  const parsed = parseStart(ticket);
  return parsed?.date ?? null;
}

// Mappa "tecnicoId|YYYY-MM-DD" → ore assegnate. Precalcolata una sola volta per
// render: ogni cella del Gantt legge la capacità in O(1) invece di scandire
// tutti i ticket (era il collo di bottiglia del drag-and-drop).
type AssignedHoursMap = Map<string, number>;

function buildAssignedHours(tickets: TicketData[]): AssignedHoursMap {
  const map: AssignedHoursMap = new Map();
  const add = (tecId: number, date: string, hours: number) => {
    const key = `${tecId}|${date}`;
    map.set(key, (map.get(key) ?? 0) + hours);
  };
  for (const t of tickets) {
    if (t.is_support) continue; // le copie "supporto" derivano dall'originale: niente doppio conteggio
    const date = plannedDate(t);
    if (!date) continue;
    const h = ticketHours(t);
    if (t.tecnico_id != null) add(t.tecnico_id, date, h);
    // Il tecnico di supporto è occupato per le stesse ore: scalalo dalla sua capacità.
    if (t.tecnico_supporto_id != null && t.tecnico_supporto_id !== t.tecnico_id) {
      add(t.tecnico_supporto_id, date, h);
    }
  }
  return map;
}

function capacityInfo(
  tecnico: TecnicoData,
  date: string,
  assignedHours: AssignedHoursMap,
  excludeTicket?: TicketData | null,
) {
  const operativo = isTecnicoOperativo(tecnico, date);
  const capacity = operativo ? Number(tecnico.ore_giornaliere || 8) : 0;
  let assigned = assignedHours.get(`${tecnico.id}|${date}`) ?? 0;
  if (excludeTicket && excludeTicket.tecnico_id === tecnico.id && plannedDate(excludeTicket) === date) {
    assigned = Math.max(0, assigned - ticketHours(excludeTicket));
  }
  const remaining = Math.max(0, capacity - assigned);
  const needed = ticketHours(excludeTicket);
  const canAccept = operativo && (!excludeTicket || remaining >= needed);
  return { operativo, capacity, assigned, remaining, needed, canAccept };
}

// ─── Lane calculator ──────────────────────────────────────────────────────────

function computeLanes(dayWOs: TicketData[]) {
  const sorted = [...dayWOs].sort((a, b) => {
    const pa = parseStart(a), pb = parseStart(b);
    const ha = pa ? pa.hour + pa.minute / 60 : 8;
    const hb = pb ? pb.hour + pb.minute / 60 : 8;
    return ha - hb;
  });
  const laneEndTime: number[] = [];
  const assignments: number[] = [];

  for (const wo of sorted) {
    const p = parseStart(wo);
    const startH = p ? p.hour + p.minute / 60 : 8;
    const dur = ticketHours(wo);
    const endH = startH + dur;
    
    // allow a slight overlap (0.01h) to prevent precision issues
    let lane = laneEndTime.findIndex(end => startH >= end - 0.01);
    if (lane === -1) lane = laneEndTime.length;
    laneEndTime[lane] = endH;
    assignments.push(lane);
  }

  const totalLanes = laneEndTime.length || 1;
  const laneMap = new Map(sorted.map((wo, i) => [wo.gantt_key ?? wo.id, { lane: assignments[i] }]));
  return { laneMap, totalLanes };
}

// ─── TicketBlock (draggable nel Gantt — stesso sistema delle card Kanban) ─────

const TicketBlock = memo(function TicketBlock({ ticket, view, onTicketClick, onHover }: {
  ticket: TicketData;
  view: ViewMode;
  onTicketClick: (t: TicketData) => void;
  onHover?: (t: TicketData | null, e?: React.MouseEvent) => void;
}) {
  const tr = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `t-${ticket.id}`,
    data: { ticket },
  });
  const s = tipoStyle(ticket.tipo);
  const dur = ticketHours(ticket);
  // useZoom deve essere chiamato unconditionally (rules-of-hooks)
  const zoom = useZoom();

  // ── Stato attività ──────────────────────────────────────────────────────────
  // In corso  → iniziata dal tecnico via mobile: NON spostabile, LED giallo lampeggiante.
  // Chiuso    → conclusa: fissa, non spostabile.
  // is_support→ copia renderizzata sulla riga del tecnico di supporto: non spostabile.
  const isSupport = !!ticket.is_support;
  const inProgress = ticket.stato === "In corso";
  const locked = ticket.stato === "Chiuso";
  const hasSupport = ticket.tecnico_supporto_id != null;
  const movable = !isSupport && !inProgress && !locked;
  const priorityShifted = !!ticket.is_priority_shifted && !isSupport;

  // Bordo sinistro: giallo per "in corso", grigio per "chiuso", colore tipo altrimenti.
  const leftBorderColor = inProgress ? "#eab308" : locked ? "#94a3b8" : s.border;
  const dragProps = movable ? { ...listeners, ...attributes } : {};
  const baseOpacity = isDragging ? 0.25 : locked ? 0.78 : isSupport ? 0.82 : 1;

  // LED giallo lampeggiante (in corso) — angolo in alto a destra del blocco.
  const led = inProgress ? (
    <span aria-label={tr("In corso")} style={{
      position: "absolute", top: 4, right: 5, width: 9, height: 9, borderRadius: "50%",
      background: "#facc15", boxShadow: "0 0 7px 1px rgba(250,204,21,0.85)",
      animation: "blinkLed 1s ease-in-out infinite", zIndex: 3, pointerEvents: "none",
    }} />
  ) : null;

  const stateTag = isSupport
    ? <span style={{ fontSize: 8, fontWeight: 900, color: "#475569", background: "rgba(148,163,184,0.22)", border: "1px solid rgba(148,163,184,0.5)", padding: "1px 5px", borderRadius: 4, letterSpacing: "0.06em", flexShrink: 0 }}>{tr("SUPPORTO")}</span>
    : inProgress
      ? <span style={{ fontSize: 8, fontWeight: 900, color: "#a16207", background: "rgba(250,204,21,0.18)", border: "1px solid rgba(234,179,8,0.55)", padding: "1px 5px", borderRadius: 4, letterSpacing: "0.06em", flexShrink: 0 }}>{tr("IN CORSO")}</span>
      : locked
        ? <span style={{ fontSize: 8, fontWeight: 900, color: "#475569", background: "rgba(148,163,184,0.2)", border: "1px solid rgba(148,163,184,0.5)", padding: "1px 5px", borderRadius: 4, letterSpacing: "0.06em", flexShrink: 0 }}>{tr("🔒 CHIUSO")}</span>
        : null;

  const supportBadge = hasSupport && !isSupport ? (
    <span title={tr("Intervento con tecnico di supporto")} style={{
      fontSize: 8, fontWeight: 900, color: "#1d4ed8", background: "rgba(59,130,246,0.14)",
      border: "1px solid rgba(59,130,246,0.5)", padding: "1px 5px", borderRadius: 999,
      letterSpacing: "0.04em", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 2,
    }}>👥 +1</span>
  ) : null;

  const shiftBadge = priorityShifted ? (
    <span title={ticket.priority_shift_reason ?? undefined} style={{
      fontSize: 8, fontWeight: 900, color: "#fbbf24", background: "rgba(245,158,11,0.16)",
      border: "1px solid rgba(245,158,11,0.65)", padding: "1px 5px", borderRadius: 4,
      letterSpacing: "0.06em", flexShrink: 0,
    }}>{tr("SPOSTATO")}</span>
  ) : null;

  if (view === "day") {
    const HOUR_W = BASE_HOUR_W * zoom;
    const ROW_H = BASE_ROW_H * zoom;
    return (
      <div
        ref={setNodeRef} {...dragProps}
        title={ticket.priority_shift_reason ?? undefined}
        onClick={(e) => { e.stopPropagation(); onTicketClick(ticket); }}
        style={{
          position: "absolute",
          width: Math.max(40, dur * HOUR_W - 6),
          height: ROW_H - 14,
          background: isSupport
            ? "repeating-linear-gradient(135deg, color-mix(in srgb, #94a3b8 12%, var(--bg-elevated)), color-mix(in srgb, #94a3b8 12%, var(--bg-elevated)) 6px, var(--bg-elevated) 6px, var(--bg-elevated) 12px)"
            : `linear-gradient(180deg, color-mix(in srgb, ${s.border} 18%, var(--bg-elevated)), color-mix(in srgb, ${s.border} 9%, var(--bg-elevated)))`,
          border: priorityShifted ? "1px solid rgba(245,158,11,0.95)" : `1px solid color-mix(in srgb, ${leftBorderColor} 50%, transparent)`,
          borderLeft: `3px ${isSupport ? "dashed" : "solid"} ${leftBorderColor}`,
          borderRadius: 10,
          padding: "6px 9px",
          cursor: movable ? (isDragging ? "grabbing" : "grab") : "default",
          opacity: baseOpacity,
          overflow: "hidden",
          userSelect: "none",
          touchAction: "none",
          boxSizing: "border-box",
          zIndex: isDragging ? 0 : 2,
          boxShadow: isDragging ? "none" : priorityShifted ? "0 0 14px 2px rgba(245,158,11,0.42)" : "0 2px 8px rgba(15,23,42,0.16)",
          animation: priorityShifted && !isDragging ? "priorityShiftPulse 1s ease-in-out infinite" : undefined,
          transition: isDragging ? "none" : "filter 0.12s, border-color 0.12s",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 3,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.filter = "brightness(1.06)";
          if (onHover && !isDragging) onHover(ticket, e);
        }}
        onMouseMove={(e) => {
          if (onHover && !isDragging) onHover(ticket, e);
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.filter = "";
          if (onHover) onHover(null);
        }}
      >
        {led}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 9, fontWeight: 800, color: s.text, background: `${s.border}22`, border: `1px solid ${s.border}66`, padding: "1px 5px", borderRadius: 4, letterSpacing: "0.06em", flexShrink: 0 }}>{ticket.tipo}</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-muted)", flexShrink: 0 }}>{dur}h</span>
          {stateTag}
          {supportBadge}
          {shiftBadge}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-primary)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.25 }}>
          {ticket.is_plan_draft ? "BOZZA · " : ""}{ticket.titolo}
        </div>
        {ticket.asset_name && (
          <div style={{ fontSize: 9, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ticket.asset_name}</div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef} {...dragProps}
      title={ticket.priority_shift_reason ?? undefined}
      onClick={(e) => { e.stopPropagation(); onTicketClick(ticket); }}
      style={{
        position: "relative",
        background: isSupport
          ? "repeating-linear-gradient(135deg, color-mix(in srgb, #94a3b8 12%, var(--bg-elevated)), color-mix(in srgb, #94a3b8 12%, var(--bg-elevated)) 6px, var(--bg-elevated) 6px, var(--bg-elevated) 12px)"
          : `linear-gradient(180deg, color-mix(in srgb, ${s.border} 16%, var(--bg-elevated)), color-mix(in srgb, ${s.border} 8%, var(--bg-elevated)))`,
        border: priorityShifted ? "1px solid rgba(245,158,11,0.95)" : `1px solid color-mix(in srgb, ${leftBorderColor} 45%, transparent)`,
        borderLeft: `3px ${isSupport ? "dashed" : "solid"} ${leftBorderColor}`,
        borderRadius: 8, padding: "5px 7px", marginBottom: 4,
        cursor: movable ? (isDragging ? "grabbing" : "grab") : "default", opacity: baseOpacity,
        overflow: "hidden", userSelect: "none", touchAction: "none", width: "100%", boxSizing: "border-box", flexShrink: 0,
        boxShadow: isDragging ? "none" : priorityShifted ? "0 0 13px 2px rgba(245,158,11,0.4)" : "0 2px 6px rgba(15,23,42,0.12)",
        animation: priorityShifted && !isDragging ? "priorityShiftPulse 1s ease-in-out infinite" : undefined,
        transition: isDragging ? "none" : "filter 0.12s, border-color 0.12s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.filter = "brightness(1.06)";
        if (onHover && !isDragging) onHover(ticket, e);
      }}
      onMouseMove={(e) => {
        if (onHover && !isDragging) onHover(ticket, e);
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.filter = "";
        if (onHover) onHover(null);
      }}
    >
      {led}
      <div style={{
        fontSize: 10,
        color: "var(--text-primary)",
        fontWeight: 700,
        overflow: "hidden",
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        whiteSpace: "normal",
        lineHeight: 1.2,
      }}>
        {ticket.is_plan_draft ? "BOZZA · " : ""}{ticket.titolo}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, color: s.text, fontWeight: 700 }}>{ticket.tipo} · {dur}h</span>
        {stateTag}
        {supportBadge}
        {shiftBadge}
      </div>
    </div>
  );
});

// ─── UnscheduledItem (sidebar sinistra, draggabile) ───────────────────────────

const UnscheduledItem = memo(function UnscheduledItem({ ticket, onTicketClick, postposto, postposeReason }: { ticket: TicketData; onTicketClick: (t: TicketData) => void; postposto?: boolean; postposeReason?: string }) {
  const tr = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `t-${ticket.id}`,
    data: { ticket },
  });
  const s = tipoStyle(ticket.tipo);
  const prioColor = PRIO_COLORS[ticket.priorita] ?? "#6b7280";

  return (
    <div
      ref={setNodeRef} {...listeners} {...attributes}
      onClick={(e) => { e.stopPropagation(); onTicketClick(ticket); }}
      title={postposto && postposeReason ? `Rimandato: ${postposeReason}` : undefined}
      style={{
        background: postposto ? "rgba(239,68,68,0.07)" : "var(--border-subtle)",
        border: postposto ? "1px solid rgba(239,68,68,0.55)" : "1px solid var(--border-subtle)",
        borderLeft: `3px solid ${postposto ? "#ef4444" : s.border}`,
        borderRadius: 8, padding: "8px 10px", marginBottom: 6,
        cursor: isDragging ? "grabbing" : "grab", opacity: isDragging ? 0.35 : 1, userSelect: "none",
        touchAction: "none",
        boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
        transition: "background 0.12s, border-color 0.12s",
        animation: postposto ? "blinkPostposto 1.1s ease-in-out infinite" : undefined,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "rgba(59,130,246,0.05)";
        (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(59,130,246,0.2)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = postposto ? "rgba(239,68,68,0.07)" : "var(--border-subtle)";
        (e.currentTarget as HTMLDivElement).style.borderColor = postposto ? "rgba(239,68,68,0.55)" : "var(--border-subtle)";
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
        <span style={{ fontSize: 9, color: s.text, letterSpacing: "0.1em", background: `${s.border}22`, border: `1px solid ${s.border}44`, padding: "1px 5px", borderRadius: 4 }}>{ticket.tipo}</span>
        {postposto
          ? <span style={{ fontSize: 9, fontWeight: 900, color: "#fca5a5", background: "rgba(239,68,68,0.16)", border: "1px solid rgba(239,68,68,0.6)", padding: "1px 6px", borderRadius: 4, letterSpacing: "0.06em" }}>{tr("RIMANDATO")}</span>
          : <span style={{ fontSize: 9, color: prioColor }}>● {labelPriorita(ticket.priorita)}</span>}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600, lineHeight: 1.3, marginBottom: 3 }}>{ticket.titolo}</div>
      <div style={{ fontSize: 10, color: "rgba(100,116,139,0.8)" }}>{ticket.durata_stimata_ore || 1}h · {ticket.asset_name || "—"}</div>
    </div>
  );
});

// ─── TecnicoLabel ─────────────────────────────────────────────────────────────

const TecnicoLabel = memo(function TecnicoLabel({ tecnico, capacity, rowIdx = 0 }: { tecnico: TecnicoData; capacity?: { capacity: number; assigned: number; remaining: number }; rowIdx?: number }) {
  const tr = useT();
  const operativo = isTecnicoOperativo(tecnico);
  const cap = capacity?.capacity ?? (operativo ? Number(tecnico.ore_giornaliere || 8) : 0);
  const remaining = capacity?.remaining ?? cap;
  const assigned = capacity?.assigned ?? 0;
  const usagePct = cap > 0 ? clamp((assigned / cap) * 100, 0, 100) : 0;

  // Display row differently only if the capacity is 0 across the viewed period
  const totalOperativo = cap > 0 || operativo;

  return (
    <div style={{
      width: LABEL_W, minWidth: LABEL_W, padding: "0 14px",
      display: "flex", alignItems: "center",
      borderRight: "2px solid var(--border-strong)",
      background: rowIdx % 2 === 1 ? "var(--surface-3)" : "var(--surface-2)",
      position: "sticky", left: 0, zIndex: 3,
      opacity: totalOperativo ? 1 : 0.72,
    }}>
      <div style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)", lineHeight: 1.25, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tecnico.nome} {tecnico.cognome ?? ""}
          </div>
          <div style={{
            fontSize: 13, fontWeight: 900, letterSpacing: "0.01em",
            color: remaining > 0 ? "var(--gantt-cap-free-text)" : "var(--gantt-cap-full-text)",
            border: `1px solid ${remaining > 0 ? "var(--gantt-cap-free-border)" : "var(--gantt-cap-full-border)"}`,
            background: remaining > 0 ? "var(--gantt-cap-free-bg)" : "var(--gantt-cap-full-bg)",
            borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap", flexShrink: 0,
          }}>
            {tr("{ore}h libere", { ore: remaining.toFixed(1) })}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {tecnico.skill ?? tecnico.competenze ?? ""}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
          <div style={{ flex: 1, height: 7, borderRadius: 999, background: "rgba(83,97,116,0.22)", overflow: "hidden" }}>
            <div style={{
              width: `${usagePct}%`, height: "100%", borderRadius: 999,
              background: usagePct > 92 ? "#e05252" : usagePct > 72 ? "#f2b84b" : "#38d978",
              boxShadow: usagePct > 92 ? "0 0 10px rgba(224,82,82,0.45)" : "0 0 10px rgba(56,217,120,0.28)",
            }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 800, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{assigned.toFixed(1)}/{cap.toFixed(1)}h</span>
        </div>
        {!totalOperativo && (
          <div style={{
            display: "inline-flex",
            marginTop: 6,
            padding: "2px 7px",
            borderRadius: 999,
            border: "1px solid rgba(224,82,82,0.45)",
            background: "rgba(224,82,82,0.15)",
            color: "#fca5a5",
            fontSize: 9,
            fontWeight: 900,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}>
            {tecnico.assenza_corrente
              ? tecnico.assenza_corrente.tipo_assenza
              : (tecnico.stato && tecnico.stato !== "in servizio" && tecnico.stato !== "in_servizio")
                ? tecnico.stato
                : tr("Non disponibile")}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── DayRow ───────────────────────────────────────────────────────────────────

const DayRow = memo(function DayRow({ tecnico, tickets, assignedHours, day, draggingTicket, onTicketClick, onHover, rowIdx = 0 }: {
  tecnico: TecnicoData; tickets: TicketData[]; assignedHours: AssignedHoursMap; day: Date; draggingTicket: TicketData | null;
  onTicketClick: (t: TicketData) => void; onHover: (t: TicketData | null, e?: React.MouseEvent) => void; rowIdx?: number;
}) {
  const tr = useT();
  const dateStr = format(day, "yyyy-MM-dd");
  const { setNodeRef, isOver } = useDroppable({
    id: `row-${tecnico.id}-${dateStr}`,
    data: { tecnico_id: tecnico.id, date: dateStr },
  });
  const dayTickets = tickets.filter((t) => { const p = parseStart(t); return p && p.date === dateStr; });
  const { laneMap, totalLanes } = computeLanes(dayTickets);
  const cap = capacityInfo(tecnico, dateStr, assignedHours);
  const dropCap = capacityInfo(tecnico, dateStr, assignedHours, draggingTicket);
  
  const zoom = useZoom();
  const HOUR_W = BASE_HOUR_W * zoom;
  const ROW_H = BASE_ROW_H * zoom;
  const timelineW = (DAY_END_H - DAY_START_H) * HOUR_W;
  
  // Calculate dynamic height if there are multiple lanes
  const laneHeight = ROW_H - 12; // Height of TicketBlock
  const dynamicHeight = Math.max(ROW_H, 6 + totalLanes * (laneHeight + 4));

  const invalidDrop = isOver && draggingTicket && !dropCap.canAccept;
  const validDrop = isOver && draggingTicket && dropCap.canAccept;

  const stripe = rowIdx % 2 === 1 ? "var(--surface-3)" : "transparent";

  return (
    <div style={{ display: "flex", height: dynamicHeight, borderBottom: "1px solid var(--border-strong)" }}>
      <TecnicoLabel tecnico={tecnico} capacity={cap} rowIdx={rowIdx} />
      <div ref={setNodeRef} style={{
        position: "relative", width: timelineW, minWidth: timelineW, height: "100%",
        background: validDrop
          ? `linear-gradient(90deg, rgba(34,197,94,0.16), rgba(34,197,94,0.06)), repeating-linear-gradient(90deg, transparent 0, transparent ${HOUR_W - 1}px, var(--border-default) ${HOUR_W - 1}px, var(--border-default) ${HOUR_W}px)`
          : invalidDrop
            ? `linear-gradient(90deg, rgba(239,68,68,0.16), rgba(239,68,68,0.06)), repeating-linear-gradient(90deg, transparent 0, transparent ${HOUR_W - 1}px, var(--border-default) ${HOUR_W - 1}px, var(--border-default) ${HOUR_W}px)`
            : `linear-gradient(0deg, ${stripe}, ${stripe}), repeating-linear-gradient(90deg, transparent 0, transparent ${HOUR_W - 1}px, var(--border-default) ${HOUR_W - 1}px, var(--border-default) ${HOUR_W}px)`,
        boxShadow: validDrop ? "inset 0 0 0 2px rgba(34,197,94,0.6), inset 0 0 32px rgba(34,197,94,0.10)" : invalidDrop ? "inset 0 0 0 2px rgba(239,68,68,0.6)" : "none",
        transition: "background 0.15s, box-shadow 0.15s",
      }}>
        {isOver && draggingTicket && (
          <div style={{
            position: "absolute", right: 12, top: 10, zIndex: 4,
            fontSize: 11, fontWeight: 800,
            color: dropCap.canAccept ? "#34d399" : "#f87171",
            background: "var(--surface-2)",
            border: `2px dashed ${dropCap.canAccept ? "#34d399" : "#f87171"}aa`,
            borderRadius: 10, padding: "6px 12px",
            boxShadow: dropCap.canAccept ? "0 0 18px rgba(52,211,153,0.25)" : "0 0 18px rgba(248,113,113,0.25)",
            animation: "pulse 1s ease-in-out infinite",
            pointerEvents: "none",
          }}>
            {dropCap.canAccept ? tr("↓ Rilascia qui · {ore}h libere", { ore: dropCap.remaining.toFixed(1) }) : !dropCap.operativo ? tr("✕ Non disponibile") : tr("✕ Capienza insufficiente ({ore}h)", { ore: dropCap.remaining.toFixed(1) })}
          </div>
        )}
        {dayTickets.map((t) => {
          const p = parseStart(t)!;
          const left = (p.hour - DAY_START_H) * HOUR_W + (p.minute / 60) * HOUR_W;
          const laneInfo = laneMap.get(t.gantt_key ?? t.id) ?? { lane: 0 };
          const top = 6 + laneInfo.lane * (laneHeight + 4);
          return (
            <div key={t.gantt_key ?? t.id} style={{ position: "absolute", left, top, zIndex: 2 }}>
              <TicketBlock ticket={t} view="day" onTicketClick={onTicketClick} onHover={onHover} />
            </div>
          );
        })}
        {!isTecnicoOperativo(tecnico, dateStr) && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "repeating-linear-gradient(135deg, rgba(224,82,82,0.04), rgba(224,82,82,0.04) 4px, transparent 4px, transparent 12px)",
            pointerEvents: "none", zIndex: 1,
          }}>
            <span style={{
              fontSize: 11, color: "rgba(252,165,165,0.7)", fontWeight: 800,
              textTransform: "uppercase", letterSpacing: "0.1em",
              background: "rgba(13,20,35,0.7)", padding: "3px 10px", borderRadius: 4,
            }}>
              {(() => {
                const assenza = tecnico.assenze?.find(a => {
                  if (!a.data_inizio || !a.data_fine) return false;
                  return dateStr >= a.data_inizio.split("T")[0] && dateStr <= a.data_fine.split("T")[0];
                });
                return assenza?.tipo_assenza ?? tecnico.stato ?? tr("Non disponibile");
              })()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

// ─── DayCell ──────────────────────────────────────────────────────────────────

const DayCell = memo(function DayCell({ tecnico, date, tickets, assignedHours, draggingTicket, onTicketClick, onHover, cellW }: {
  tecnico: TecnicoData; date: string; tickets: TicketData[]; assignedHours: AssignedHoursMap; draggingTicket: TicketData | null;
  onTicketClick: (t: TicketData) => void; onHover: (t: TicketData | null, e?: React.MouseEvent) => void; cellW: number;
}) {
  const tr = useT();
  const { setNodeRef, isOver } = useDroppable({
    id: `cell-${tecnico.id}-${date}`,
    data: { tecnico_id: tecnico.id, date },
  });
  const cap = capacityInfo(tecnico, date, assignedHours);
  const dropCap = capacityInfo(tecnico, date, assignedHours, draggingTicket);
  const validDrop = isOver && draggingTicket && dropCap.canAccept;
  const invalidDrop = isOver && draggingTicket && !dropCap.canAccept;
  
  const zoom = useZoom();
  const ROW_H = BASE_ROW_H * zoom;
  
  // Find if there is an absence specifically for this day
  const assenzaGiorno = tecnico.assenze?.find(a => {
    if (!a.data_inizio || !a.data_fine) return false;
    const start = a.data_inizio.split("T")[0];
    const end = a.data_fine.split("T")[0];
    return date >= start && date <= end;
  });

  return (
    <div ref={setNodeRef} style={{
      width: cellW, minWidth: cellW, minHeight: ROW_H, padding: "4px 3px",
      borderRight: "1px solid var(--border-default)",
      background: validDrop
        ? "linear-gradient(180deg, rgba(34,197,94,0.18), rgba(34,197,94,0.06))"
        : invalidDrop
          ? "linear-gradient(180deg, rgba(239,68,68,0.18), rgba(239,68,68,0.06))"
            : assenzaGiorno
            ? "linear-gradient(180deg, rgba(239,68,68,0.10), rgba(239,68,68,0.03))"
            : cap.operativo && cap.remaining > 0
              ? "transparent"
              : "linear-gradient(180deg, rgba(245,158,11,0.08), rgba(245,158,11,0.03))",
      boxShadow: validDrop ? "inset 0 0 0 2px rgba(34,197,94,0.6), inset 0 0 26px rgba(34,197,94,0.12)" : invalidDrop ? "inset 0 0 0 2px rgba(239,68,68,0.6)" : "none",
      transition: "background 0.15s, box-shadow 0.15s", overflow: "hidden",
      display: "flex", flexDirection: "column", gap: 1,
      position: "relative",
    }}>
      {assenzaGiorno && (
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          fontSize: 10, color: "var(--text-danger)", fontWeight: 900, textTransform: "uppercase",
          letterSpacing: "0.08em", background: "rgba(239,68,68,0.14)",
          border: "1px solid rgba(239,68,68,0.4)", borderRadius: 6,
          padding: "3px 8px", whiteSpace: "nowrap", pointerEvents: "none", zIndex: 2,
          textAlign: "center",
        }}>
          {assenzaGiorno.tipo_assenza}
        </div>
      )}
      <div style={{
        display: "flex", justifyContent: "center", alignItems: "center", gap: 4,
        alignSelf: "center", fontSize: 12, fontWeight: 900, letterSpacing: "0.01em",
        color: cap.remaining > 0 ? "var(--gantt-cap-free-text)" : "var(--gantt-cap-full-text)",
        background: cap.remaining > 0 ? "var(--gantt-cap-free-bg)" : "var(--gantt-cap-full-bg)",
        border: `1px solid ${cap.remaining > 0 ? "var(--gantt-cap-free-border)" : "var(--gantt-cap-full-border)"}`,
        borderRadius: 999, padding: "2px 8px", margin: "1px 0 4px",
        flexShrink: 0, whiteSpace: "nowrap", lineHeight: 1.15,
      }}>
        <span>{cap.remaining.toFixed(1)}h</span>
        <span style={{ opacity: 0.75 }}>/ {cap.capacity.toFixed(0)}h</span>
      </div>
      {isOver && draggingTicket && (
        <div style={{
          fontSize: 10, fontWeight: 800, textAlign: "center",
          color: dropCap.canAccept ? "#34d399" : "#f87171",
          padding: "8px 2px",
          border: `2px dashed ${dropCap.canAccept ? "#34d399" : "#f87171"}88`,
          borderRadius: 8, marginBottom: 3,
          background: dropCap.canAccept ? "rgba(52,211,153,0.07)" : "rgba(248,113,113,0.07)",
          animation: "pulse 1s ease-in-out infinite",
          pointerEvents: "none", lineHeight: 1.35, flexShrink: 0,
        }}>
          {dropCap.canAccept
            ? <>{tr("↓ Rilascia qui")}<br />{tr("{ore}h libere", { ore: dropCap.remaining.toFixed(1) })}</>
            : !dropCap.operativo
              ? tr("✕ Non disponibile")
              : <>{tr("✕ Capienza piena")}<br />{tr("{ore}h libere", { ore: dropCap.remaining.toFixed(1) })}</>}
        </div>
      )}
      {tickets.map((t) => <TicketBlock key={t.gantt_key ?? t.id} ticket={t} view="week" onTicketClick={onTicketClick} onHover={onHover} />)}
    </div>
  );
});

// ─── MultiDayRow ──────────────────────────────────────────────────────────────

const MultiDayRow = memo(function MultiDayRow({ tecnico, tickets, assignedHours, days, view, draggingTicket, onTicketClick, onHover, rowIdx = 0 }: {
  tecnico: TecnicoData; tickets: TicketData[]; assignedHours: AssignedHoursMap; days: Date[]; view: ViewMode; draggingTicket: TicketData | null;
  onTicketClick: (t: TicketData) => void; onHover: (t: TicketData | null, e?: React.MouseEvent) => void; rowIdx?: number;
}) {
  const zoom = useZoom();
  const DAY_W = BASE_DAY_W * zoom;
  const ROW_H = BASE_ROW_H * zoom;
  const cellW = view === "week" ? DAY_W : Math.round(DAY_W * 0.75);
  const rowCapacity = days.reduce((acc, day) => {
    const c = capacityInfo(tecnico, format(day, "yyyy-MM-dd"), assignedHours);
    acc.capacity += c.capacity;
    acc.assigned += c.assigned;
    acc.remaining += c.remaining;
    return acc;
  }, { capacity: 0, assigned: 0, remaining: 0 });
  return (
    <div style={{ display: "flex", minHeight: ROW_H, borderBottom: "1px solid var(--border-strong)", background: rowIdx % 2 === 1 ? "var(--surface-3)" : "transparent" }}>
      <TecnicoLabel tecnico={tecnico} capacity={rowCapacity} rowIdx={rowIdx} />
      {days.map((day) => {
        const dateStr = format(day, "yyyy-MM-dd");
        return (
          <DayCell
            key={dateStr} tecnico={tecnico} date={dateStr}
            tickets={tickets.filter((t) => { const p = parseStart(t); return p && p.date === dateStr; })}
            assignedHours={assignedHours}
            draggingTicket={draggingTicket}
            onTicketClick={onTicketClick} onHover={onHover} cellW={cellW}
          />
        );
      })}
    </div>
  );
});

// ─── DragGhostCard (overlay durante il drag — stesso stile del Kanban) ────────

function DragGhostCard({ ticket }: { ticket: TicketData }) {
  const s = tipoStyle(ticket.tipo);
  const prioColor = PRIO_COLORS[ticket.priorita] ?? "#6b7280";
  return (
    <div style={{
      background: "var(--bg-elevated)",
      border: `2px solid ${s.border}`,
      borderRadius: 12,
      padding: "12px 14px",
      minWidth: 200, maxWidth: 280,
      boxShadow: `0 20px 60px rgba(0,0,0,0.7), 0 0 24px ${s.border}55`,
      transform: "rotate(2deg) scale(1.02)",
      pointerEvents: "none", userSelect: "none",
      display: "flex", flexDirection: "column", gap: 8,
      cursor: "grabbing",
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.35 }}>
        {ticket.titolo}
      </div>
      {ticket.asset_name && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ opacity: 0.7 }}>📦</span> {ticket.asset_name}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, fontWeight: 800, color: s.text, background: `${s.border}22`, border: `1px solid ${s.border}55`, letterSpacing: "0.05em" }}>
          {ticket.tipo} · #{ticket.id}
        </span>
        <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, fontWeight: 700, textTransform: "uppercase", color: prioColor, background: `${prioColor}15`, border: `1px solid ${prioColor}30` }}>
          {labelPriorita(ticket.priorita)}
        </span>
        <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: "rgba(251,191,36,0.1)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)", fontWeight: 700 }}>
          {ticketHours(ticket)}h
        </span>
      </div>
    </div>
  );
}

// ─── TicketDetailDrawer ───────────────────────────────────────────────────────

function TicketDetailDrawer({ ticket, onClose }: { ticket: TicketData; onClose: () => void }) {
  const s = tipoStyle(ticket.tipo);
  const prioColor = PRIO_COLORS[ticket.priorita] ?? "#6b7280";
  const rows = [
    ["Stato", ticket.stato],
    ["Priorità", ticket.priorita],
    ["Tipo", ticket.tipo],
    ["Asset", ticket.asset_name || "—"],
    ["Durata stimata", ticket.durata_stimata_ore ? `${ticket.durata_stimata_ore}h` : "—"],
    ["Inizio pianificato", ticket.planned_start ? format(parseISO(ticket.planned_start), "dd/MM/yyyy HH:mm", { locale: it }) : "—"],
    ["Fine pianificata", ticket.planned_finish ? format(parseISO(ticket.planned_finish), "dd/MM/yyyy HH:mm", { locale: it }) : "—"],
  ] as const;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9998, display: "flex" }} onClick={onClose}>
      <div style={{ flex: 1 }} />
      <div style={{
        width: 360, height: "100%", background: "var(--surface-2)",
        borderLeft: "1px solid var(--border-strong)", padding: 24, overflowY: "auto",
        display: "flex", flexDirection: "column", gap: 16,
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <span style={{ fontSize: 9, letterSpacing: "0.15em", color: s.text, background: `${s.border}22`, border: `1px solid ${s.border}`, padding: "3px 8px" }}>
            {ticket.tipo} · #{ticket.id}
          </span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.4 }}>{ticket.titolo}</div>
          {ticket.descrizione && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.6 }}>{ticket.descrizione}</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, padding: "8px 0", borderBottom: "1px solid var(--border-strong)" }}>
              <span style={{ color: "#6b7280" }}>{label}</span>
              <span style={{ color: label === "Priorità" ? prioColor : "var(--text-primary)", fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Modale pianificazione manuale ────────────────────────────────────────────

const SLOT_PRESETS = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];

function ModalePianificaManuale({ ticket, tecnici, ganttTickets, defaultTecnicoId, defaultDate, defaultStart, onSave, onClose }: {
  ticket: TicketData; tecnici: TecnicoData[]; ganttTickets: TicketData[];
  defaultTecnicoId?: number | null; defaultDate?: string | null; defaultStart?: string | null;
  onSave: (ticketId: number, tecnicoId: number, data: string, start: string, finish: string, tecnicoSupportoId: number | null) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const todayStr = localDateStr();
  const [tecnicoId, setTecnicoId] = useState<number>(
    defaultTecnicoId ?? ticket.tecnico_id ?? (tecnici.find(t => isTecnicoOperativo(t)) ?? tecnici[0])?.id ?? 0
  );
  const [tecnicoSupportoId, setTecnicoSupportoId] = useState<number>(ticket.tecnico_supporto_id ?? 0);
  const initialDate = (defaultDate && defaultDate >= todayStr) ? defaultDate : (defaultDate ?? todayStr);
  const [data, setData] = useState<string>(initialDate < todayStr ? todayStr : initialDate);
  const [oraInizio, setOraInizio] = useState<string>(defaultStart ?? "08:00");

  const durata = ticketHours(ticket);
  const startDec = hhmmToDec(oraInizio);
  const fineDec = startDec + durata;
  const oraFineLabel = decToHHMM(fineDec);

  const isPast = data < todayStr;

  // Intervalli occupati del tecnico principale e del supporto nella data scelta.
  const conflict = useMemo(() => {
    if (isPast) return null;
    const checkTec = (tecId: number, label: string) => {
      if (!tecId) return null;
      const busy = busyIntervalsForTecnico(ganttTickets, tecId, data, ticket.id);
      if (!intervalsOverlap(busy, startDec, fineDec)) return null;
      const free = firstFreeSlot(busy, durata);
      return { who: label, suggestion: free != null ? decToHHMM(free) : null };
    };
    return checkTec(tecnicoId, "tecnico") ?? (tecnicoSupportoId ? checkTec(tecnicoSupportoId, "supporto") : null);
  }, [ganttTickets, tecnicoId, tecnicoSupportoId, data, startDec, fineDec, durata, ticket.id, isPast]);

  const fineOltreGiornata = fineDec > DAY_END_H + 1e-9;
  const blocked = isPast || !tecnicoId || !!conflict || fineOltreGiornata || tecnicoSupportoId === tecnicoId;
  const s = tipoStyle(ticket.tipo);

  // Chiusura con ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9998,
        background: "rgba(2,6,23,0.55)", backdropFilter: "blur(3px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          position: "relative",
          width: "min(480px, 96vw)", maxHeight: "90vh",
          background: "var(--surface-2)", color: "var(--text-primary)",
          border: "1px solid var(--border-strong)", borderRadius: 14,
          boxShadow: "0 28px 70px rgba(2,6,23,0.45)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          zIndex: 9999,
        }}
      >
        <button onClick={onClose} aria-label={tr("Chiudi")} style={{ position: "absolute", top: 14, right: 14, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-3)", border: "1px solid var(--border-default)", borderRadius: 8, color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, zIndex: 2 }}>×</button>
        <div style={{ padding: "24px 28px", borderBottom: "1px solid var(--border-default)", background: "var(--surface-1)" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.15em", color: "var(--cobalt)", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>{tr("Pianifica intervento")}</div>
          <div style={{ color: "var(--text-primary)", fontSize: 18, fontWeight: 800, paddingRight: 28 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: s.text, background: `${s.border}1f`, border: `1px solid ${s.border}66`, padding: "2px 7px", borderRadius: 5, marginRight: 8 }}>{ticket.tipo}</span>
            #{ticket.id} — {ticket.titolo}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>{tr("Durata stimata:")} {durata}h · {ticket.asset_name ?? "—"}</div>
        </div>

        <div style={{ flex: 1, padding: "24px 28px", display: "flex", flexDirection: "column", gap: 18, overflowY: "auto" }}>
          <div>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 6, fontWeight: 700, letterSpacing: "0.05em" }}>{tr("TECNICO ASSEGNATO")}</label>
            <select value={tecnicoId} onChange={(e) => setTecnicoId(Number(e.target.value))} style={{ width: "100%", background: "var(--surface-1)", border: "1px solid var(--border-default)", color: "var(--text-primary)", borderRadius: 8, padding: "10px 12px", fontSize: 14 }}>
              {tecnici.map((t) => (
                <option key={t.id} value={t.id} disabled={!isTecnicoOperativo(t, data)}>
                  {t.nome} {t.cognome ?? ""} · {isTecnicoOperativo(t, data) ? `${t.ore_giornaliere || 8}h/gg` : tr("non disponibile")}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 6, fontWeight: 700, letterSpacing: "0.05em" }}>{tr("TECNICO DI SUPPORTO (opzionale)")}</label>
            <select value={tecnicoSupportoId} onChange={(e) => setTecnicoSupportoId(Number(e.target.value))} style={{ width: "100%", background: "var(--surface-1)", border: "1px solid var(--border-default)", color: "var(--text-primary)", borderRadius: 8, padding: "10px 12px", fontSize: 14 }}>
              <option value={0}>{tr("Nessuno")}</option>
              {tecnici.filter(t => t.id !== tecnicoId).map((t) => (
                <option key={t.id} value={t.id} disabled={!isTecnicoOperativo(t, data)}>
                  {t.nome} {t.cognome ?? ""} {isTecnicoOperativo(t, data) ? "" : tr("· non disponibile")}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 6, fontWeight: 700, letterSpacing: "0.05em" }}>{tr("DATA")}</label>
            <input type="date" value={data} min={todayStr} onChange={(e) => setData(e.target.value < todayStr ? todayStr : e.target.value)} style={{ width: "100%", background: "var(--surface-1)", border: `1px solid ${isPast ? "var(--text-danger)" : "var(--border-default)"}`, color: "var(--text-primary)", borderRadius: 8, padding: "10px 12px", fontSize: 14, boxSizing: "border-box" }} />
            {isPast && <div style={{ fontSize: 11, color: "var(--text-danger)", marginTop: 6, fontWeight: 600 }}>{tr("Non è possibile pianificare in una data passata.")}</div>}
          </div>

          <div>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 8, fontWeight: 700, letterSpacing: "0.05em" }}>{tr("ORA INIZIO")}</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input type="time" value={oraInizio} step={1800} onChange={(e) => setOraInizio(e.target.value || "08:00")} style={{ background: "var(--surface-1)", border: "1px solid var(--border-default)", color: "var(--text-primary)", borderRadius: 8, padding: "8px 10px", fontSize: 14 }} />
              <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>{tr("→ fine")} {oraFineLabel}</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {SLOT_PRESETS.map((p) => (
                <button key={p} onClick={() => setOraInizio(p)} style={{ fontSize: 12, padding: "5px 11px", borderRadius: 6, cursor: "pointer", border: `1px solid ${oraInizio === p ? "var(--cobalt-border)" : "var(--border-default)"}`, background: oraInizio === p ? "var(--cobalt-dim)" : "var(--surface-1)", color: oraInizio === p ? "var(--cobalt)" : "var(--text-muted)", fontWeight: oraInizio === p ? 700 : 500 }}>
                  {p}
                </button>
              ))}
            </div>
            {fineOltreGiornata && !conflict && (
              <div style={{ fontSize: 11, color: "var(--text-warning)", marginTop: 8, fontWeight: 600 }}>
                {tr("L'intervento supera l'orario di fine giornata (")}{decToHHMM(DAY_END_H)}).
              </div>
            )}
          </div>

          {conflict && (
            <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 12, color: "var(--text-danger)", fontWeight: 700, marginBottom: 4 }}>
                {tr("⚠ Sovrapposizione con un'altra attività (")}{conflict.who === "supporto" ? tr("tecnico di supporto") : tr("tecnico assegnato")}).
              </div>
              {conflict.suggestion ? (
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {tr("Primo orario utile per questo giorno:")}{" "}
                  <button onClick={() => setOraInizio(conflict.suggestion!)} style={{ background: "var(--cobalt-dim)", border: "1px solid var(--cobalt-border)", color: "var(--cobalt)", borderRadius: 6, padding: "2px 9px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                    {conflict.suggestion}
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{tr("Nessuno slot libero in giornata: scegli un'altra data.")}</div>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: "18px 28px", borderTop: "1px solid var(--border-default)", background: "var(--surface-2)", display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button onClick={onClose} style={{ padding: "9px 18px", background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text-muted)", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{tr("Annulla")}</button>
          <button
            disabled={blocked}
            onClick={() => {
              onSave(
                ticket.id, tecnicoId, data,
                `${data}T${oraInizio}:00`, `${data}T${oraFineLabel}:00`,
                tecnicoSupportoId || null,
              );
              onClose();
            }}
            style={{ padding: "9px 24px", background: blocked ? "var(--surface-4)" : "linear-gradient(135deg, #3b82f6, #2563eb)", border: "none", color: blocked ? "var(--text-disabled)" : "#ffffff", borderRadius: 8, cursor: blocked ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 700, boxShadow: blocked ? "none" : "0 4px 12px rgba(59,130,246,0.3)" }}
          >
            {tr("✓ Pianifica (")}{oraInizio} – {oraFineLabel})
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Pagina principale ────────────────────────────────────────────────────────

export default function PianificazionePage() {
  // Gantt state
  const tr = useT();
  const [view, setView] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [tecnici, setTecnici] = useState<TecnicoData[]>([]);
  const [scheduledTickets, setScheduledTickets] = useState<TicketData[]>([]);
  const [unscheduledTickets, setUnscheduledTickets] = useState<TicketData[]>([]);
  const [optimisticPlannedIds, setOptimisticPlannedIds] = useState<Set<number>>(() => new Set());
  const [movedTicketIds, setMovedTicketIds] = useState<Set<number>>(() => new Set());
  const [movedTicketReasons, setMovedTicketReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [draggingTicket, setDraggingTicket] = useState<TicketData | null>(null);
  const [detailTicket, setDetailTicket] = useState<TicketData | null>(null);
  const [filterTipo, setFilterTipo] = useState("");
  const [selectedWO, setSelectedWO] = useState<{ wo: PlannedWO; ticket: TicketData; tecnico: TecnicoData | null } | null>(null);
  // Modale pianificazione: aperta al drop di un ticket sul Gantt (orario + supporto + anti-overlap)
  const [planModal, setPlanModal] = useState<{ ticket: TicketData; tecnicoId: number; date: string; startTime: string } | null>(null);

  // Piano AI state
  const [piano, setPiano] = useState<GeneratedPlan | null>(null);
  const [generando, setGenerando] = useState(false);
  const [confermando, setConfermando] = useState(false);
  const [storico, setStorico] = useState<GeneratedPlan[]>([]);
  const [replanModal, setReplanModal] = useState(false);
  const [zoom, setZoom] = useState(1);

  // Generazione piano (auto-scheduling deterministico)
  const [scheduleMode, setScheduleMode] = useState<"proposta" | "auto">("proposta");
  const [summaryModal, setSummaryModal] = useState<SchedulingSummary | null>(null);

  // Tooltip hover: lo stato cambia solo quando cambia il ticket; la posizione
  // viene aggiornata direttamente sul DOM (nessun re-render per mousemove —
  // era la causa principale della lentezza del Gantt).
  const [hoverTicket, setHoverTicket] = useState<TicketData | null>(null);
  const hoverPosRef = useRef({ x: 0, y: 0 });
  const tooltipElRef = useRef<HTMLDivElement | null>(null);

  const handleHover = useCallback((ticket: TicketData | null, e?: React.MouseEvent) => {
    if (e) {
      hoverPosRef.current = { x: e.clientX, y: e.clientY };
      const el = tooltipElRef.current;
      if (el) {
        el.style.left = `${e.clientX + 15}px`;
        el.style.top = `${e.clientY + 15}px`;
      }
    }
    setHoverTicket((prev) => (prev === ticket ? prev : ticket));
  }, []);

  const applyMovedTicketMarkers = useCallback((source: { moved_tickets?: number[]; plan_json?: { moved_tickets?: number[]; moved_ticket_reasons?: Record<string, string> } } | null | undefined) => {
    const ids = source?.moved_tickets ?? source?.plan_json?.moved_tickets ?? [];
    setMovedTicketIds(new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))));
    setMovedTicketReasons(source?.plan_json?.moved_ticket_reasons ?? {});
  }, []);

  // Orizzonte auto-esteso lato backend (nessun selettore): il motore pianifica
  // l'intero backlog estendendo i giorni necessari.
  const [includeWeekends] = useState(false);
  const [allowOvertime] = useState(false);

  const [manualEval, setManualEval] = useState<{ score: number; breakdown: EfficiencyBreakdown } | null>(null);
  const [scoreLoading, setScoreLoading] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Stessa logica del Kanban ma più precisa per le celle del Gantt: vince la
  // cella sotto il puntatore, con fallback all'intersezione dei rettangoli.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    return pointerCollisions.length > 0 ? pointerCollisions : rectIntersection(args);
  }, []);

  // ── Dati piano ──────────────────────────────────────────────────────────────
  const planJson = piano?.plan_json ?? { planned_workorders: [], deferred_workorders: [], fermo_assets: [], global_warnings: [] };
  const effScore: number | undefined = manualEval?.score ?? planJson?.efficiency_score;
  const effBreakdown: EfficiencyBreakdown | undefined = manualEval?.breakdown ?? planJson?.efficiency_breakdown;

  // ── Lookup maps per WODetailDrawer ─────────────────────────────────────────
  const ticketMap = useMemo(() => {
    const map = new Map<number, TicketData>();
    [...scheduledTickets, ...unscheduledTickets].forEach((t) => map.set(t.id, t));
    return map;
  }, [scheduledTickets, unscheduledTickets]);

  const tecnicoMap = useMemo(() => {
    const map = new Map<number, TecnicoData>();
    tecnici.forEach((t) => map.set(t.id, t));
    return map;
  }, [tecnici]);

  // ── Contatori deferred dai piani storici (#12) ─────────────────────────────
  // ── Statistiche backlog ─────────────────────────────────────────────────────
  // Ticket "rimandati" dalla proposta corrente (deferred) → lampeggiano in sidebar
  const deferredMap = useMemo(() => {
    const m = new Map<number, string>();
    if (piano?.status === "draft") {
      (planJson?.deferred_workorders ?? []).forEach((d) => {
        if (d.wo_id != null) m.set(d.wo_id, d.reason);
      });
    }
    return m;
  }, [piano?.status, planJson?.deferred_workorders]);

  const plannedPlanIds = useMemo(() => {
    const ids = new Set(optimisticPlannedIds);
    (planJson?.planned_workorders ?? []).forEach((wo) => ids.add(Number(wo.wo_id)));
    return ids;
  }, [optimisticPlannedIds, planJson?.planned_workorders]);

  const tipoCounts = useMemo(() => {
    const counts = { BD: 0, PM: 0, CM: 0 };
    unscheduledTickets.filter((t) => !plannedPlanIds.has(Number(t.id))).forEach((t) => {
      if (t.tipo in counts) counts[t.tipo as keyof typeof counts]++;
    });
    return counts;
  }, [plannedPlanIds, unscheduledTickets]);

  const ganttTickets = useMemo(() => {
    const markMoved = (ticket: TicketData): TicketData => {
      const shifted = movedTicketIds.has(Number(ticket.id));
      if (!shifted) return ticket;
      return markMoved({
        ...ticket,
        is_priority_shifted: true,
        priority_shift_reason: movedTicketReasons[String(ticket.id)] ?? "Spostato per priorita maggiore",
      });
    };

    if (!piano) return scheduledTickets.map(markMoved);

    // Mostra anche i WO di un piano in bozza (proposta auto-scheduling) sul Gantt,
    // così il planner può rivedere la proposta prima di confermarla.
    const draftWos = planJson?.planned_workorders ?? [];
    if (!draftWos.length) return scheduledTickets.map(markMoved);

    const draftIds = new Set(draftWos.map((wo) => wo.wo_id));
    const lockedOrPersisted = scheduledTickets.filter((t) => !draftIds.has(t.id)).map(markMoved);
    const draftTickets: TicketData[] = draftWos.map((wo) => {
      const base = ticketMap.get(wo.wo_id);
      const start = planDateTime(wo.planned_date, wo.planned_start_time);
      const finish = planDateTime(wo.planned_date, wo.planned_end_time);
      return {
        id: wo.wo_id,
        titolo: base?.titolo ?? `Ticket #${wo.wo_id}`,
        asset_id: base?.asset_id ?? 0,
        asset_name: base?.asset_name ?? null,
        tipo: base?.tipo ?? "CM",
        priorita: base?.priorita ?? "Media",
        stato: piano?.status === "draft" ? "Bozza piano" : (base?.stato ?? "Pianificato"),
        durata_stimata_ore: wo.duration_hours ?? base?.durata_stimata_ore ?? 1,
        fascia_oraria: base?.fascia_oraria ?? "",
        descrizione: base?.descrizione ?? null,
        tecnico_id: wo.technician_id,
        planned_start: start,
        planned_finish: finish,
        gantt_key: `${piano?.id ?? "draft"}-${wo.wo_id}-${wo.planned_date}-${wo.planned_start_time}-${wo.is_continuation ? "cont" : "main"}`,
        is_plan_draft: piano?.status === "draft",
      };
    });

    return [...lockedOrPersisted, ...draftTickets];
  }, [piano, planJson?.planned_workorders, scheduledTickets, ticketMap, movedTicketIds, movedTicketReasons]);

  // ── Mappe precalcolate per il Gantt (capacità O(1), righe stabili) ──────────
  const assignedHours = useMemo(() => buildAssignedHours(ganttTickets), [ganttTickets]);

  const ticketsByTecnico = useMemo(() => {
    const map = new Map<number, TicketData[]>();
    const push = (tecId: number, t: TicketData) => {
      const arr = map.get(tecId);
      if (arr) arr.push(t);
      else map.set(tecId, [t]);
    };
    for (const t of ganttTickets) {
      if (t.tecnico_id != null) push(t.tecnico_id, t);
      // Lavoro multi-tecnico: renderizza una copia "supporto" sulla riga del secondo operatore.
      if (t.tecnico_supporto_id != null && t.tecnico_supporto_id !== t.tecnico_id) {
        push(t.tecnico_supporto_id, {
          ...t,
          is_support: true,
          gantt_key: `${t.gantt_key ?? t.id}-support-${t.tecnico_supporto_id}`,
        });
      }
    }
    return map;
  }, [ganttTickets]);

  // ── Caricamento dati ────────────────────────────────────────────────────────
  const loadStorico = useCallback(async () => {
    try {
      const res = await apiGet<GeneratedPlan[]>("/planning/history").catch(() => []);
      setStorico(res ?? []);
    } catch { /* silenzioso */ }
  }, []);

  // ── Generazione piano: deterministico (default) o Felix Agent (AI) ────────
  const [generandoStatus, setGenerandoStatus] = useState("Elaborazione...");

  async function generatePlan(mode: "deterministic" | "agent" = "deterministic") {
    const isAgent = mode === "agent";
    setGenerando(true);
    setGenerandoStatus(isAgent ? "Felix Agent al lavoro..." : "Generazione piano in corso...");
    try {
      // Warm-up ping: sveglia il backend prima della richiesta (cold start Render)
      try {
        await apiGet<unknown>("/health", { signal: AbortSignal.timeout(5000) });
      } catch {
        setGenerandoStatus("Connessione backend...");
      }

      setGenerandoStatus(isAgent ? "Felix Agent: ottimizzazione piano..." : "Calcolo assegnazioni...");
      const res = await apiPost<GeneratedPlan & { previous_efficiency_score?: number }>("/planning/generate", {
        mode,
        include_weekends: includeWeekends,
        allow_overtime: allowOvertime,
      });
      const { previous_efficiency_score: _prev, ...cleanRes } = res;
      void _prev;
      applyMovedTicketMarkers(cleanRes);

      const summary = cleanRes.plan_json?.scheduling_summary ?? null;
      const nScheduled = summary?.tickets_scheduled ?? cleanRes.plan_json?.planned_workorders?.length ?? 0;
      const generatedPlannedIds = new Set(
        (cleanRes.plan_json?.planned_workorders ?? []).map((wo) => Number(wo.wo_id)),
      );
      setOptimisticPlannedIds(generatedPlannedIds);
      setUnscheduledTickets((prev) => prev.filter((t) => !generatedPlannedIds.has(Number(t.id))));

      // Modalità conferma automatica: conferma subito il piano appena generato.
      if (scheduleMode === "auto" && cleanRes.id) {
        setGenerandoStatus("Conferma automatica...");
        try {
          const confirmed = await apiPost<GeneratedPlan>(`/planning/confirm/${cleanRes.id}`);
          applyMovedTicketMarkers(confirmed ?? cleanRes);
          setPiano(confirmed ?? { ...cleanRes, status: "confirmed" });
          notify.success(tn("Piano confermato — {nScheduled} ticket schedulati", { nScheduled: nScheduled }));
          loadStorico();
        } catch (ce: unknown) {
          setPiano(cleanRes);
          notify.error(ce instanceof Error ? ce.message : "Errore conferma automatica del piano");
        }
      } else {
        setPiano(cleanRes);
        notify.success(
          isAgent
            ? `Proposta Felix Agent generata — ${nScheduled} ticket schedulati`
            : `Proposta generata — ${nScheduled} ticket schedulati`,
        );
      }

      // Felix Agent: se l'agente è degradato al motore deterministico, avvisa il planner
      const meta = cleanRes.plan_json?.plan_metadata;
      if (isAgent && meta?.agent_fallback) {
        notify.warning(
          tr("Felix Agent non disponibile ({valore}): piano generato dal motore deterministico", { valore: meta.agent_fallback_reason ?? "errore agente" }),
        );
      }

      const planStart = cleanRes.plan_json?.plan_metadata?.planning_start_date;
      setCurrentDate(planStart ? parseISO(planStart) : new Date());
      if (summary) setSummaryModal(summary);
      await loadData(false, generatedPlannedIds); // aggiorna il Gantt senza ripopolare la sidebar
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Errore durante la generazione del piano";
      // 503 dal backend: generazione AI dietro flag AI_PLANNING_ENABLED
      if (isAgent && msg.toLowerCase().includes("disattivata")) {
        notify.error(tn("Felix Agent non è attivo su questo ambiente (flag AI_PLANNING_ENABLED). Usa la generazione standard."));
      } else {
        notify.error(msg);
      }
    } finally {
      setGenerando(false);
      setGenerandoStatus("Elaborazione...");
    }
  }

  const loadData = useCallback(async (background = false, hidePlannedIds?: Set<number>) => {
    if (!background) setLoading(true);
    try {
      const [tecniciRes, activeRes, planRes] = await Promise.all([
        apiGet<TecnicoAPI[]>("/tecnici", { cache: "no-store", headers: { "Cache-Control": "no-store" } }),
        apiGet<{ items: TicketData[] }>("/tickets?limit=200&stato=Aperto,Pianificato,In%20corso,Chiuso", {
          cache: "no-store",
          headers: { "Cache-Control": "no-store" },
        }),
        apiGet<GeneratedPlan | null>("/planning/current", {
          cache: "no-store",
          headers: { "Cache-Control": "no-store" },
        }).catch(() => null),
      ]);

      setTecnici((tecniciRes ?? []).map((t) => ({ ...t, competenze: t.skill ?? "" })));
      const activeTickets = activeRes.items ?? [];
      const planIds = new Set<number>(hidePlannedIds ?? []);
      (planRes?.plan_json?.planned_workorders ?? []).forEach((wo) => planIds.add(Number(wo.wo_id)));
      setOptimisticPlannedIds(planIds);
      // Pianificati/in corso/chiusi con orario → sul Gantt (i chiusi restano fissi).
      const scheduled = activeTickets.filter((t) => t.planned_start != null);
      // Sidebar "non pianificati": solo ticket ancora aperti senza orario.
      const unscheduled = activeTickets.filter((t) => t.planned_start == null && t.stato === "Aperto" && !planIds.has(Number(t.id)));
      setScheduledTickets(scheduled);
      setUnscheduledTickets(unscheduled);
      setPiano(planRes);
      if (planRes) applyMovedTicketMarkers(planRes);
    } catch (e: unknown) {
      if (!background) notify.error(e instanceof Error ? e.message : "Errore caricamento dati");
    } finally {
      if (!background) setLoading(false);
    }
  }, [applyMovedTicketMarkers]);

  useEffect(() => { loadData(); loadStorico(); }, [loadData, loadStorico]);

  async function requestScoreUpdate() {
    setScoreLoading(true);
    try {
      const evalRes = await apiPost<{ efficiency_score: number; efficiency_breakdown: EfficiencyBreakdown }>("/planning/evaluate");
      setManualEval({ score: evalRes.efficiency_score, breakdown: evalRes.efficiency_breakdown });
      notify.success(tn("Score aggiornato: {valore}", { valore: Math.round(evalRes.efficiency_score) }));
    } catch (e: unknown) {
      notify.error(e instanceof Error ? e.message : "Errore aggiornamento score");
    } finally {
      setScoreLoading(false);
    }
  }

  // ── Conferma piano ──────────────────────────────────────────────────────────
  async function confirmPlan() {
    if (!piano) return;
    setConfermando(true);
    try {
      const confirmed = await apiPost<GeneratedPlan>(`/planning/confirm/${piano.id}`);
      applyMovedTicketMarkers(confirmed ?? piano);
      setPiano(confirmed ?? { ...piano, status: "confirmed" });
      notify.success(tn("Piano confermato"));
      await loadData();
      loadStorico();
    } catch (e: unknown) {
      notify.error(e instanceof Error ? e.message : "Errore conferma piano");
    } finally {
      setConfermando(false);
    }
  }

  async function clearGantt() {
    if (!confirm(tn("Sei sicuro di voler svuotare il Gantt? Tutti i ticket torneranno nello stato 'Aperto'."))) return;
    try {
      await apiPost("/planning/clear");
      setMovedTicketIds(new Set());
      setMovedTicketReasons({});
      notify.success(tn("Gantt svuotato con successo"));
      await loadData();
    } catch {
      notify.error(tn("Errore durante lo svuotamento del Gantt"));
    }
  }

  // ── Pianificazione manuale ──────────────────────────────────────────────────
  async function savePianificazioneManuale(
    ticketId: number,
    tecnicoId: number,
    data: string,
    start: string,
    finish: string,
    tecnicoSupportoId: number | null,
  ) {
    try {
      const ticket = ticketMap.get(ticketId) ?? planModal?.ticket ?? null;
      const tecnico = tecnicoMap.get(tecnicoId);
      if (!ticket || !tecnico) return;

      // Guardia finale: niente date passate.
      if (data < localDateStr()) {
        notify.warning(tn("Non è possibile pianificare un intervento in una data passata."));
        return;
      }
      if (!isTecnicoOperativo(tecnico, data)) {
        notify.warning(tn("{nome} {valore} non disponibile: ticket non pianificato", { nome: tecnico.nome, valore: tecnico.cognome ?? "" }));
        return;
      }

      // --- OPTIMISTIC UPDATE ---
      const patch = {
        tecnico_id: tecnicoId,
        tecnico_supporto_id: tecnicoSupportoId,
        planned_start: start,
        planned_finish: finish,
        stato: "Pianificato",
      };
      const updateTicketList = (list: TicketData[]) =>
        list.map(t => (t.id === ticketId ? { ...t, ...patch } : t));

      if (ticket.planned_start) {
        setScheduledTickets(prev => updateTicketList(prev));
      } else {
        setScheduledTickets(prev => [...prev, { ...ticket, ...patch }]);
        setUnscheduledTickets(prev => prev.filter(t => t.id !== ticketId));
      }
      // -------------------------

      await apiPut(`/tickets/${ticketId}`, {
        tecnico_id: tecnicoId,
        tecnico_supporto_id: tecnicoSupportoId,
        planned_start: start,
        planned_finish: finish,
        stato: "Pianificato",
        is_manual_plan: true,
      });
      notify.success(
        tecnicoSupportoId
          ? `Ticket #${ticketId} pianificato (2 tecnici)`
          : `Ticket #${ticketId} pianificato`,
      );
      loadData(true); // background sync
    } catch (e: unknown) {
      notify.error(e instanceof Error ? e.message : "Errore salvataggio");
      loadData(true); // revert in case of error
    }
  }

  // ── DnD: drag start ─────────────────────────────────────────────────────────
  function handleDragStart(event: DragStartEvent) {
    const ticket = (event.active.data.current as { ticket?: TicketData })?.ticket;
    if (ticket) {
      setDraggingTicket(ticket);
      setHoverTicket(null);
    }
  }

  // ── DnD: drag end ───────────────────────────────────────────────────────────
  async function handleDragEnd(event: DragEndEvent) {
    setDraggingTicket(null);
    const { active, over } = event;
    if (!over) return;

    const droppedTicket = (active.data.current as { ticket?: TicketData })?.ticket;
    if (!droppedTicket) return;

    const dropTarget = over.data.current as { tecnico_id?: number; date?: string } | undefined;
    if (!dropTarget?.tecnico_id || !dropTarget?.date) return;
    const targetTecnico = tecnicoMap.get(dropTarget.tecnico_id);
    if (!targetTecnico) return;

    // Le attività iniziate/concluse non sono spostabili.
    if (droppedTicket.stato === "In corso" || droppedTicket.stato === "Chiuso") {
      notify.warning(tn("Il ticket #{id} è \"{stato}\" e non può essere ripianificato.", { id: droppedTicket.id, stato: droppedTicket.stato }));
      return;
    }

    // Non si può pianificare prima della data odierna corrente.
    const todayStr = localDateStr();
    if (dropTarget.date < todayStr) {
      notify.warning(tn("Non è possibile pianificare un intervento in una data passata."));
      return;
    }

    if (!isTecnicoOperativo(targetTecnico, dropTarget.date)) {
      notify.warning(tn("{nome} {valore} non disponibile in questa data.", { nome: targetTecnico.nome, valore: targetTecnico.cognome ?? "" }));
      return;
    }

    // Orario di partenza suggerito dalla posizione del drop (solo vista giorno),
    // altrimenti primo slot libero del tecnico per quella giornata.
    let startTime = "08:00";
    if (view === "day") {
      const droppableRect = over.rect;
      const draggedRect = event.active.rect.current.translated;
      if (draggedRect && droppableRect) {
        const relX = Math.max(0, draggedRect.left - droppableRect.left);
        const totalMin = (relX / (BASE_HOUR_W * zoom)) * 60;
        const rounded = Math.round(totalMin / 30) * 30;
        const h = clamp(DAY_START_H + Math.floor(rounded / 60), DAY_START_H, DAY_END_H - 1);
        startTime = `${String(h).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
      }
    } else {
      const busy = busyIntervalsForTecnico(ganttTickets, dropTarget.tecnico_id, dropTarget.date, droppedTicket.id);
      const free = firstFreeSlot(busy, ticketHours(droppedTicket));
      if (free != null) startTime = decToHHMM(free);
    }

    // Apre la modale: chiede orario di inizio e (opzionale) tecnico di supporto,
    // validando le sovrapposizioni prima del salvataggio.
    setPlanModal({
      ticket: droppedTicket,
      tecnicoId: dropTarget.tecnico_id,
      date: dropTarget.date,
      startTime,
    });
  }
  // ── Navigazione data ────────────────────────────────────────────────────────
  function navigate(dir: 1 | -1) {
    const delta = view === "day" ? 1 : view === "week" ? 7 : 14;
    setCurrentDate((d) => (dir === 1 ? addDays(d, delta) : subDays(d, delta)));
  }

  const days = useMemo(() => getDays(currentDate, view), [currentDate, view]);
  const cellW = view === "week" ? BASE_DAY_W * zoom : Math.round(BASE_DAY_W * zoom * 0.75);
  const timelineMinW = LABEL_W + (view === "day" ? (DAY_END_H - DAY_START_H) * (BASE_HOUR_W * zoom) : days.length * cellW);
  // In modalità proposta i ticket già piazzati nella bozza sono sul Gantt:
  // la sidebar mostra solo quelli NON pianificati (i "rimandati"), che lampeggiano.
  const visibleUnscheduledTickets = useMemo(
    () => unscheduledTickets.filter((t) => !plannedPlanIds.has(Number(t.id))),
    [unscheduledTickets, plannedPlanIds],
  );
  const filteredUnscheduled = filterTipo ? visibleUnscheduledTickets.filter((t) => t.tipo === filterTipo) : visibleUnscheduledTickets;
  const columnCapacity = useMemo(() => {
    const map = new Map<string, { capacity: number; assigned: number; remaining: number; unavailable: number }>();
    days.forEach((day) => {
      const date = format(day, "yyyy-MM-dd");
      const totals = tecnici.reduce((acc, tecnico) => {
        const c = capacityInfo(tecnico, date, assignedHours);
        acc.capacity += c.capacity;
        acc.assigned += c.assigned;
        acc.remaining += c.remaining;
        if (!c.operativo) acc.unavailable += 1;
        return acc;
      }, { capacity: 0, assigned: 0, remaining: 0, unavailable: 0 });
      map.set(date, totals);
    });
    return map;
  }, [days, tecnici, assignedHours]);

  // Click su un blocco del Gantt: callback stabile (non invalida la memo delle righe)
  const handleTicketClick = useCallback((t: TicketData) => {
    // Se esiste un WO nel piano per questo ticket, apre il drawer explainability
    const wo = piano?.plan_json?.planned_workorders?.find((w) => w.wo_id === t.id) ?? null;
    if (wo) {
      const tec = tecnicoMap.get(wo.technician_id)
        ?? (t.tecnico_id != null ? tecnicoMap.get(t.tecnico_id) : undefined)
        ?? null;
      setSelectedWO({ wo, ticket: ticketMap.get(t.id) ?? t, tecnico: tec });
    } else {
      setDetailTicket(t);
    }
  }, [piano, tecnicoMap, ticketMap]);

  const openTicketDetail = useCallback((t: TicketData) => setDetailTicket(t), []);
  const dateLabel =
    view === "day"
      ? format(days[0]!, "EEEE d MMMM yyyy", { locale: it })
      : `${format(days[0]!, "d MMM", { locale: it })} – ${format(days[days.length - 1]!, "d MMM yyyy", { locale: it })}`;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <ZoomContext.Provider value={zoom}>
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setDraggingTicket(null)}>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--surface-0)", fontFamily: "'IBM Plex Mono', monospace", color: "var(--text-primary)" }}>

        {/* ── TOOLBAR ── */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "0 16px",
          borderBottom: "1px solid var(--border-default)",
          background: "var(--surface-2)",
          flexShrink: 0,
          flexWrap: "nowrap",
          height: 52,
          minHeight: 52,
          overflowX: "auto",
          overflowY: "hidden",
          whiteSpace: "nowrap",
        }}>
          {/* View toggle */}
          <div style={{ display: "flex", gap: 2, background: "var(--surface-3)", border: "1px solid rgba(59,130,246,0.18)", borderRadius: 8, padding: "3px", flexShrink: 0 }}>
            {(["day", "week", "2week"] as ViewMode[]).map((v) => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: "4px 10px", fontSize: 10, letterSpacing: "0.1em",
                background: view === v ? "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)" : "transparent",
                color: view === v ? "#fff" : "var(--text-muted)",
                border: "none",
                borderRadius: 5,
                cursor: "pointer", fontFamily: "inherit", fontWeight: view === v ? 700 : 500,
                transition: "all 0.12s",
                boxShadow: view === v ? "0 2px 8px rgba(59,130,246,0.4)" : "none",
              }}>
                {v === "day" ? "GIORNO" : v === "week" ? "SETTIMANA" : "2 SETT."}
              </button>
            ))}
          </div>

          {/* Date nav */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <button onClick={() => navigate(-1)} style={{ background: "transparent", border: "1px solid var(--border-default)", color: "var(--text-muted)", width: 28, height: 28, cursor: "pointer", fontSize: 16, lineHeight: 1, borderRadius: 5 }}>‹</button>
            <button onClick={() => setCurrentDate(new Date())} style={{ background: "transparent", border: "1px solid var(--border-default)", color: "var(--text-muted)", padding: "4px 10px", fontSize: 10, letterSpacing: "0.1em", cursor: "pointer", fontFamily: "inherit", borderRadius: 5 }}>{tr("OGGI")}</button>
            <button onClick={() => navigate(1)} style={{ background: "transparent", border: "1px solid var(--border-default)", color: "var(--text-muted)", width: 28, height: 28, cursor: "pointer", fontSize: 16, lineHeight: 1, borderRadius: 5 }}>›</button>
          </div>

          {/* Controlli Zoom */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, borderLeft: "1px solid var(--border-default)", paddingLeft: 12, flexShrink: 0 }}>
            <button
              onClick={() => setZoom(z => Math.max(0.8, z - 0.2))}
              style={{ background: "transparent", border: "1px solid var(--border-default)", color: "var(--text-muted)", width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 16, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
              title={tr("Zoom Out")}
            >
              -
            </button>
            <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 32, textAlign: "center", fontWeight: 600 }}>
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom(z => Math.min(2.0, z + 0.2))}
              style={{ background: "transparent", border: "1px solid var(--border-default)", color: "var(--text-muted)", width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 16, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
              title={tr("Zoom In")}
            >
              +
            </button>
          </div>

          <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 700, textTransform: "capitalize", flexShrink: 0 }}>{dateLabel}</span>

          <div style={{ flex: "1 1 auto", minWidth: 12 }} />

          {/* Efficienza badge compatta — pill premium */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, whiteSpace: "nowrap" }}>
          {effScore !== undefined && (
            <span 
              title={effBreakdown 
                ? `Dettagli Score:\nCopertura Backlog: ${effBreakdown.copertura_backlog?.toFixed(1)}%\nUtilizzo Tecnici: ${effBreakdown.utilizzo_tecnici?.toFixed(1)}%\nRispetto Priorità: ${effBreakdown.rispetto_priorita?.toFixed(1)}%\nRiduzione Spostamenti: ${effBreakdown.riduzione_spostamenti?.toFixed(1)}%\nMatching Competenze: ${effBreakdown.matching_competenze?.toFixed(1)}%`
                : tr("Score di efficienza del piano")}
              style={{
              fontSize: 11, fontWeight: 800, padding: "4px 12px", borderRadius: 20,
              background: effScore >= 80
                ? "linear-gradient(135deg, rgba(20,83,45,0.6), rgba(5,150,105,0.3))"
                : effScore >= 60
                  ? "linear-gradient(135deg, rgba(120,53,15,0.6), rgba(245,158,11,0.2))"
                  : "linear-gradient(135deg, rgba(127,29,29,0.6), rgba(239,68,68,0.2))",
              color: effScore >= 80 ? "#86efac" : effScore >= 60 ? "#fcd34d" : "#fca5a5",
              border: `1px solid ${effScore >= 80 ? "rgba(34,197,94,0.4)" : effScore >= 60 ? "rgba(245,158,11,0.4)" : "rgba(239,68,68,0.4)"}`,
              boxShadow: effScore >= 80
                ? "0 0 10px rgba(34,197,94,0.15)"
                : effScore >= 60
                  ? "0 0 10px rgba(245,158,11,0.15)"
                  : "0 0 10px rgba(239,68,68,0.15)",
              letterSpacing: "0.05em",
            }}>
              {tr("◈ Score")} {Math.round(effScore)}
            </span>
          )}

          <button
            onClick={requestScoreUpdate}
            disabled={scoreLoading}
            title={tr("Calcola lo score solo quando richiesto")}
            style={{
              background: scoreLoading ? "rgba(31,41,55,0.8)" : "rgba(31,232,255,0.10)",
              border: "1px solid rgba(31,232,255,0.34)",
              color: "#a6f6ff",
              borderRadius: 8,
              padding: "7px 12px",
              fontSize: 11,
              fontWeight: 800,
              cursor: scoreLoading ? "wait" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {scoreLoading ? "Score..." : "Aggiorna score"}
          </button>

          {/* Piano status badge Nascosto */}

          {/* Engine toggle Nascosto per richiesta utente */}

          {/* Selettore orizzonte rimosso: il motore auto-estende l'orizzonte
              fino a pianificare l'intero backlog (nessuna finestra fissa). */}

          {/* Toggle LUN-VEN e Turni Nascosti */}

          {/* Selettore modalità: proposta (bozza) o conferma automatica */}
          <div style={{ display: "flex", gap: 2, background: "var(--surface-3)", border: "1px solid rgba(99,102,241,0.18)", borderRadius: 8, padding: "3px", flexShrink: 0 }}>
            {([["proposta", "Proposta"], ["auto", "Conferma auto"]] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setScheduleMode(val)}
                title={val === "proposta" ? tr("Genera una bozza da rivedere e confermare") : tr("Genera e conferma automaticamente il piano")}
                style={{
                  padding: "4px 10px", fontSize: 11, fontWeight: 700,
                  borderRadius: 5, border: "none",
                  background: scheduleMode === val ? "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)" : "transparent",
                  color: scheduleMode === val ? "#fff" : "var(--text-muted)",
                  cursor: "pointer", fontFamily: "inherit", transition: "all 0.12s",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Generazione piano — motore deterministico (saturazione ore) */}
          <button
            onClick={() => generatePlan("deterministic")}
            disabled={generando}
            title={tr("Genera automaticamente il piano assegnando i ticket ai tecnici (no weekend)")}
            style={{
              background: generando
                ? "rgba(31,41,55,0.8)"
                : "linear-gradient(135deg, #1d4ed8, #4f46e5)",
              border: "1px solid rgba(99,102,241,0.45)", color: "#fff", borderRadius: 8, padding: "8px 20px",
              fontSize: 12, fontWeight: 800, cursor: generando ? "wait" : "pointer",
              boxShadow: generando ? "none" : "0 2px 10px rgba(79,70,229,0.4)",
              display: "flex", alignItems: "center", gap: 6, transition: "box-shadow 0.12s", flexShrink: 0,
            }}
          >
            {generando ? generandoStatus : tr("Generazione piano")}
          </button>

          {/* Felix Agent — motore agentico AI (OpenAI Agents SDK, flag AI_PLANNING_ENABLED) */}
          <button
            onClick={() => generatePlan("agent")}
            disabled={generando}
            title={tr("Genera il piano con Felix Agent: parte dalla baseline deterministica e la ottimizza (meteo, logistica, bilanciamento). Richiede AI attiva sul backend.")}
            style={{
              background: generando
                ? "rgba(31,41,55,0.8)"
                : "linear-gradient(135deg, #7c3aed, #a855f7)",
              border: "1px solid rgba(168,85,247,0.45)", color: "#fff", borderRadius: 8, padding: "8px 16px",
              fontSize: 12, fontWeight: 800, cursor: generando ? "wait" : "pointer",
              boxShadow: generando ? "none" : "0 2px 10px rgba(124,58,237,0.4)",
              display: "flex", alignItems: "center", gap: 6, transition: "box-shadow 0.12s", flexShrink: 0,
            }}
          >
            {tr("🤖 Felix Agent")}
          </button>

          {/* Badge motore — visibile quando il piano corrente è stato generato dall'agente */}
          {planJson?.plan_metadata?.generated_by === "agent" && (
            <span
              title={planJson.plan_metadata.agent_fallback
                ? `Fallback deterministico: ${planJson.plan_metadata.agent_fallback_reason ?? tr("errore agente")}`
                : `Piano ottimizzato da Felix Agent (${planJson.plan_metadata.agent_turns ?? "?"} turni)`}
              style={{
                padding: "4px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, flexShrink: 0,
                background: planJson.plan_metadata.agent_fallback ? "rgba(245,158,11,0.15)" : "rgba(168,85,247,0.15)",
                border: `1px solid ${planJson.plan_metadata.agent_fallback ? "rgba(245,158,11,0.4)" : "rgba(168,85,247,0.4)"}`,
                color: planJson.plan_metadata.agent_fallback ? "#f59e0b" : "#c084fc",
              }}
            >
              {planJson.plan_metadata.agent_fallback ? "🤖 Agent → fallback" : "🤖 Felix Agent"}
            </span>
          )}

          {/* Conferma proposta — visibile solo quando esiste una bozza da approvare */}
          {piano?.status === "draft" && (planJson?.planned_workorders?.length ?? 0) > 0 && (
            <button
              onClick={confirmPlan}
              disabled={confermando}
              title={tr("Applica la proposta: assegna i ticket ai tecnici e pianificali")}
              style={{
                background: confermando ? "rgba(31,41,55,0.8)" : "linear-gradient(135deg, #16a34a, #22c55e)",
                border: "1px solid rgba(34,197,94,0.5)", color: "#fff", borderRadius: 8, padding: "8px 18px",
                fontSize: 12, fontWeight: 800, cursor: confermando ? "wait" : "pointer",
                boxShadow: confermando ? "none" : "0 2px 10px rgba(22,163,74,0.4)",
                display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
              }}
            >
              {confermando ? "Conferma..." : "✓ Conferma proposta"}
            </button>
          )}

          {/* Ricalcola piano — DISATTIVATO (riattivare cambiando false → true) */}
          {false && piano && (
            <button
              onClick={() => setReplanModal(true)}
              title={tr("Ricalcola piano adattivamente")}
              style={{
                background: "transparent",
                border: "1px solid rgba(55,65,81,0.8)",
                color: "rgba(148,163,184,0.8)",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "border-color 0.12s, color 0.12s",
              }}
            >
              {tr("↻ Ricalcola")}
            </button>
          )}

          {/* Svuota Gantt */}
          <button
            onClick={clearGantt}
            title={tr("Svuota il Gantt e riporta i ticket ad Aperto")}
            style={{
              background: "transparent",
              border: "1px solid rgba(239,68,68,0.5)",
              color: "#fca5a5",
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 0.12s",
            }}
          >
            {tr("Svuota Gantt")}
          </button>

          </div>

          {/* Refresh */}
          <button onClick={() => loadData()} disabled={loading} title={tr("Aggiorna")} style={{
            background: "transparent", border: "1px solid rgba(55,65,81,0.8)", color: "rgba(148,163,184,0.8)",
            width: 28, height: 28, cursor: "pointer", fontSize: 14, opacity: loading ? 0.5 : 1,
            borderRadius: 6, transition: "border-color 0.12s",
          }}>↻</button>
        </div>

        {/* ── BODY ── */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

          {/* ── SIDEBAR sinistra ── */}
          <div style={{
            width: 256, minWidth: 256, borderRight: "1px solid rgba(59,130,246,0.1)",
            background: "var(--surface-1)", display: "flex", flexDirection: "column", overflow: "hidden",
          }}>
            {/* Header sidebar */}
            <div style={{
              padding: "10px 12px", flexShrink: 0,
              background: "linear-gradient(90deg, rgba(59,130,246,0.08), transparent)",
              borderBottom: "1px solid rgba(59,130,246,0.12)",
            }}>
              <div style={{ fontSize: 10, letterSpacing: "0.15em", color: "rgba(148,163,184,0.7)", marginBottom: 8, fontWeight: 700 }}>{tr("NON PIANIFICATI")}</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                {(["", "BD", "PM", "CM"] as const).map((tipo) => {
                  const color = tipo === "BD" ? "#ef4444" : tipo === "PM" ? "#22c55e" : tipo === "CM" ? "#f59e0b" : "#6b7280";
                  const cnt = tipo ? tipoCounts[tipo] : visibleUnscheduledTickets.length;
                  return (
                    <button key={tipo || "all"} onClick={() => setFilterTipo(tipo)} style={{
                      fontSize: 9, padding: "2px 7px",
                      background: filterTipo === tipo ? `${color}22` : "transparent",
                      border: `1px solid ${color}`, color, borderRadius: 3, cursor: "pointer", fontFamily: "inherit",
                    }}>
                      {tipo || tr("TUTTI")} ({cnt})
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: "#4b5563" }}>{tr("Trascina sulla timeline o clicca per pianificare →")}</div>
            </div>

            {/* Lista ticket non pianificati */}
            <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
              {loading ? (
                <div style={{ color: "#4b5563", fontSize: 12, textAlign: "center", paddingTop: 24 }}>{tr("Caricamento...")}</div>
              ) : filteredUnscheduled.length === 0 ? (
                <div style={{ color: "#4b5563", fontSize: 12, textAlign: "center", paddingTop: 24 }}>{tr("Nessun ticket da pianificare")}</div>
              ) : (
                filteredUnscheduled.map((t) => (
                  <UnscheduledItem key={t.id} ticket={t} onTicketClick={openTicketDetail} postposto={deferredMap.has(t.id)} postposeReason={deferredMap.get(t.id)} />
                ))
              )}
            </div>

          </div>

          {/* ── GANTT TIMELINE ── */}
          <div style={{ flex: 1, overflow: "auto", position: "relative", background: "var(--surface-0)" }}>
            {loading ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#6b7280", fontSize: 13 }}>
                {tr("Caricamento dati...")}
              </div>
            ) : (
              <div style={{ minWidth: timelineMinW }}>
                {/* Header colonne */}
                <div style={{
                  display: "flex", height: 68,
                  borderBottom: "1px solid var(--border-default)",
                  background: "var(--surface-2)",
                  position: "sticky", top: 0, zIndex: 10,
                }}>
                  <div style={{
                    width: LABEL_W, minWidth: LABEL_W, display: "flex", flexDirection: "column",
                    alignItems: "flex-start", justifyContent: "center",
                    padding: "0 14px", borderRight: "1px solid var(--border-default)",
                    fontSize: 12, color: "var(--text-secondary)", letterSpacing: "0.08em", fontWeight: 800,
                    position: "sticky", left: 0,
                    background: "var(--surface-2)", zIndex: 11,
                  }}>
                    <span style={{ lineHeight: 1.1 }}>{tr("TECNICO")}</span>
                    <span style={{ fontSize: 11, fontWeight: 800, lineHeight: 1.2, color: "var(--gantt-cap-free-text)", marginTop: 4 }}>{tr("ORE RESIDUE")}</span>
                  </div>
                  {view === "day"
                    ? Array.from({ length: DAY_END_H - DAY_START_H }, (_, i) => (
                        <div key={i} style={{ width: BASE_HOUR_W * zoom, minWidth: BASE_HOUR_W * zoom, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", boxSizing: "border-box", borderRight: "1px solid var(--border-subtle)", fontSize: 10, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.08em", whiteSpace: "nowrap", overflow: "visible" }}>
                          {String(DAY_START_H + i).padStart(2, "0")}:00
                        </div>
                      ))
                    : days.map((day) => {
                        const today = isToday(day);
                        const cap = columnCapacity.get(format(day, "yyyy-MM-dd"));
                        const compactHeader = view === "2week";
                        return (
                          <div key={day.toISOString()} style={{
                            width: cellW, minWidth: cellW, display: "flex", flexDirection: "column",
                            alignItems: "center", justifyContent: "center", height: "100%",
                            padding: "4px 6px", boxSizing: "border-box", overflow: "visible",
                            borderRight: "1px solid var(--border-subtle)",
                            background: today ? "var(--cobalt-dim)" : "transparent",
                          }}>
                            <div style={{ fontSize: compactHeader ? 8 : 9, color: today ? "var(--cobalt)" : "var(--text-muted)", letterSpacing: "0.08em", fontWeight: 700, whiteSpace: "nowrap", lineHeight: 1.15 }}>
                              {format(day, "EEE", { locale: it }).toUpperCase()}
                            </div>
                            <div style={{
                              fontSize: compactHeader ? 12 : 13, fontWeight: 700, color: today ? "var(--cobalt)" : "var(--text-primary)",
                              textShadow: today ? "0 0 8px rgba(96,165,250,0.6)" : "none",
                              whiteSpace: "nowrap", lineHeight: 1.15,
                            }}>
                              {format(day, "d")}
                            </div>
                            <div style={{
                              fontSize: compactHeader ? 11 : 12, fontWeight: 900, marginTop: 3,
                              whiteSpace: "nowrap", lineHeight: 1.1,
                              color: (cap?.remaining ?? 0) > 0 ? "var(--gantt-cap-free-text)" : "var(--gantt-cap-full-text)",
                              background: (cap?.remaining ?? 0) > 0 ? "var(--gantt-cap-free-bg)" : "var(--gantt-cap-full-bg)",
                              border: `1px solid ${(cap?.remaining ?? 0) > 0 ? "var(--gantt-cap-free-border)" : "var(--gantt-cap-full-border)"}`,
                              borderRadius: 999, padding: compactHeader ? "1px 6px" : "2px 8px",
                            }}>
                              {(cap?.remaining ?? 0).toFixed(1)}h / {(cap?.capacity ?? 0).toFixed(0)}h
                            </div>
                          </div>
                        );
                      })}
                </div>

                {/* Righe tecnici */}
                {tecnici.length === 0 ? (
                  <div style={{ padding: 40, textAlign: "center", color: "#6b7280", fontSize: 13 }}>{tr("Nessun tecnico attivo trovato")}</div>
                ) : (
                  tecnici.map((tecnico, rowIdx) => {
                    const tickets = ticketsByTecnico.get(tecnico.id) ?? EMPTY_TICKETS;
                    if (view === "day") {
                      return (
                        <DayRow
                          key={tecnico.id}
                          rowIdx={rowIdx}
                          tecnico={tecnico}
                          tickets={tickets}
                          assignedHours={assignedHours}
                          day={days[0]!}
                          draggingTicket={draggingTicket}
                          onTicketClick={handleTicketClick}
                          onHover={handleHover}
                        />
                      );
                    }
                    return (
                      <MultiDayRow
                        key={tecnico.id}
                        rowIdx={rowIdx}
                        tecnico={tecnico}
                        tickets={tickets}
                        assignedHours={assignedHours}
                        days={days}
                        view={view}
                        draggingTicket={draggingTicket}
                        onTicketClick={handleTicketClick}
                        onHover={handleHover}
                      />
                    );
                  })
                )}
              </div>
            )}
          </div>


        </div>

        {/* ── STORICO PIANI ── */}
        <div style={{ display: "none",
          borderTop: "1px solid rgba(59,130,246,0.08)",
          padding: "0 16px 24px",
          background: "var(--surface-0)",
          maxHeight: 320, overflowY: "auto",
        }}>
          <StoricoPiani piani={storico} onRefresh={loadStorico} />
        </div>

        {/* DragOverlay: card flottante ad alta visibilità — stesso sistema del Kanban */}
        <DragOverlay dropAnimation={null}>
          {draggingTicket ? <DragGhostCard ticket={draggingTicket} /> : null}
        </DragOverlay>
      </div>

      {/* Drawer dettaglio ticket */}
      {detailTicket && <TicketDetailDrawer ticket={detailTicket} onClose={() => setDetailTicket(null)} />}

      {/* Modale pianificazione manuale */}
      {planModal && (
        <ModalePianificaManuale
          ticket={planModal.ticket}
          tecnici={tecnici}
          ganttTickets={ganttTickets}
          defaultTecnicoId={planModal.tecnicoId}
          defaultDate={planModal.date}
          defaultStart={planModal.startTime}
          onSave={savePianificazioneManuale}
          onClose={() => setPlanModal(null)}
        />
      )}

      {/* WODetailDrawer — "Perché Qui?" */}
      <WODetailDrawer
        wo={selectedWO?.wo ?? null}
        ticket={selectedWO?.ticket ?? null}
        tecnico={selectedWO?.tecnico ?? null}
        onClose={() => setSelectedWO(null)}
      />

      {/* Hover Tooltip (Nuvoletta Descrittiva) — posizione aggiornata via DOM ref, zero re-render */}
      {hoverTicket && !draggingTicket && (
        <div ref={tooltipElRef} style={{
          position: "fixed", top: hoverPosRef.current.y + 15, left: hoverPosRef.current.x + 15, zIndex: 10000,
          background: "rgba(10, 22, 40, 0.95)", backdropFilter: "blur(8px)",
          border: `1px solid ${tipoStyle(hoverTicket.tipo).border}`,
          borderRadius: 8, padding: "10px 14px", color: "#f8fafc", width: 280,
          boxShadow: "0 20px 40px rgba(0,0,0,0.5), 0 0 20px rgba(0,0,0,0.2)",
          pointerEvents: "none", transition: "opacity 0.1s",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: tipoStyle(hoverTicket.tipo).text, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {hoverTicket.tipo} · #{hoverTicket.id}
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
              {ticketHours(hoverTicket)}h
            </span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3, marginBottom: 4 }}>
            {hoverTicket.titolo}
          </div>
          <div style={{ fontSize: 11, color: "#cbd5e1", lineHeight: 1.4 }}>
            {hoverTicket.descrizione && hoverTicket.descrizione.length > 80
              ? hoverTicket.descrizione.substring(0, 80) + "..."
              : hoverTicket.descrizione || tr("Nessuna descrizione.")}
          </div>
          {(hoverTicket.asset_name || hoverTicket.impianto_name || hoverTicket.sito_name) && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-default)", fontSize: 10, color: "var(--text-muted)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: "#64748b" }}>📍</span>
                {hoverTicket.sito_name} › {hoverTicket.impianto_name}
              </div>
              <div style={{ fontWeight: 600, color: "#e2e8f0", marginTop: 2, paddingLeft: 16 }}>
                {hoverTicket.asset_name}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ReplanModal — Ricalcolo adattivo */}
      <ReplanModal
        open={replanModal}
        piano={piano}
        onClose={() => setReplanModal(false)}
        onSuccess={(result) => {
          applyMovedTicketMarkers(result);
          setReplanModal(false);
          loadData();
          loadStorico();
        }}
      />

      {/* Riepilogo KPI dopo la generazione piano */}
      {summaryModal && (
        <SchedulingSummaryModal summary={summaryModal} onClose={() => setSummaryModal(null)} />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
        @keyframes blinkPostposto {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.0); border-color: rgba(239,68,68,0.55); }
          50%      { box-shadow: 0 0 10px 1px rgba(239,68,68,0.55); border-color: rgba(239,68,68,0.95); }
        }
        @keyframes blinkLed {
          0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 7px 1px rgba(250,204,21,0.9); }
          50%      { opacity: 0.35; transform: scale(0.82); box-shadow: 0 0 3px 0px rgba(250,204,21,0.45); }
        }
        @keyframes priorityShiftPulse {
          0%, 100% { box-shadow: 0 0 10px 1px rgba(245,158,11,0.25); }
          50%      { box-shadow: 0 0 18px 3px rgba(245,158,11,0.72); }
        }
      `}</style>
    </DndContext>
    </ZoomContext.Provider>
  );
}
