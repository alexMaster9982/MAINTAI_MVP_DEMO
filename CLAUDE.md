# CLAUDE.md

Guida per Claude Code su questo repository. Aggiornato alla versione **3.3.2** (2026-08-06).

> Esiste anche `AGENTS.md` (guida per Codex): stesso dominio, meno dettaglio, aggiornato
> separatamente. Questo file è la fonte più completa.

---

## ⚠️ Sicurezza — linee guida obbligatorie (leggere PRIMA di ogni modifica)

Il riferimento di sicurezza del progetto sono questi documenti, da applicare **sempre** come base per ogni modifica:

- [`docs/SECURITY_GUIDELINES.md`](docs/SECURITY_GUIDELINES.md) — guida operativa completa (OWASP Top 10, API Security, file upload, AI/LLM, SSRF, secrets).
- [`docs/SECURITY_CHECKLIST.md`](docs/SECURITY_CHECKLIST.md) — checklist rapida da usare prima di ogni PR/deploy.
- [`docs/SECURITY_GUIDELINES_MAINTAI.md`](docs/SECURITY_GUIDELINES_MAINTAI.md) — addendum specifico MaintAI (multi-tenant, background job, serving file backend, endpoint pubblici QR, adattamento Python/FastAPI).

**Regole d'uso:**
- Prima di scrivere/modificare codice che tocca auth, query DB, input utente, upload, chiamate AI/esterne o config, consulta la sezione pertinente delle linee guida.
- Prima di ogni PR esegui la checklist di `docs/SECURITY_CHECKLIST.md`.
- Classifica ogni vulnerabilità trovata con la scala Critica/Alta/Media/Bassa definita nelle linee guida.

**Mappatura stack** (le guide sono scritte per Next.js/Prisma/Auth.js — qui lo stack è FastAPI/SQLAlchemy/JWT; i principi OWASP restano identici):

| Concetto nella guida | Equivalente in MaintAI |
|---|---|
| Auth.js / `auth()` | JWT in `backend/core/security.py` (`get_current_user_payload`, `require_superadmin`, `require_roles`) |
| RBAC `requireRole()` | `require_superadmin` / `require_roles("responsabile")` + `get_current_tenant_id` |
| Prisma `findFirst({ id, tenantId })` | query SQLAlchemy con `.filter(Model.tenant_id == tenant_id)` + `check_tenant_ownership()` |
| Validazione con Zod | schema **Pydantic** (`backend/schemas/`) con `Field(min_length/max_length/...)` |
| Route Handler / Server Action | router FastAPI (`backend/api/routes/*`) con `Depends(...)` |
| `NEXT_PUBLIC_*` | env `NEXT_PUBLIC_*` nel frontend Next.js (stesso rischio: bundle client) |
| `next.config.js` security headers | middleware `security_headers` in `backend/main.py` **e** `frontend/next.config.ts` |
| Rate limiting `@upstash/ratelimit` | `slowapi` via `backend/core/rate_limiter.py` (`@limiter.limit(...)`) |
| Validazione upload | `backend/core/file_validation.py` (`validate_upload`, `validate_magic`, `safe_serving`) |
| Storage privato + signed URL | `backend/core/storage.py` (Supabase) — bucket **privato**, serving solo via endpoint autenticati |
| Cifratura at-rest | `encrypt_data`/`decrypt_data` (Fernet) in `security.py` |
| Prompt injection | `backend/services/ai/prompt_security.py` (`wrap_untrusted`, `UNTRUSTED_INPUT_POLICY`) |
| Minimizzazione dati verso LLM (LLM06) | **`Pseudonymizer`** in `backend/services/ai/pseudonymizer.py` — obbligatorio su ogni chiamata OpenAI |

**Dati verso OpenAI — regola non negoziabile:** ogni call site AI deve pseudonimizzare il
payload con `Pseudonymizer` (token deterministici `ASSET_3`/`TECNICO_7`) e ripassare la
risposta da `restore()` prima di UI e persistenza. Si tokenizza **l'identificatore**, mai la
semantica tecnica: marca, modello, misure, tolleranze e codici ricambio restano in chiaro,
altrimenti si degrada l'AI senza guadagno di privacy. Criteri completi e checklist in
[`docs/SECURITY_GUIDELINES_MAINTAI.md`](docs/SECURITY_GUIDELINES_MAINTAI.md) §6; il test
`backend/tests/test_ai_pseudonymization.py` contiene una guardia che fallisce se un nuovo
modulo chiama OpenAI senza passare da un servizio di masking.

Altri presidi già in essere, da non rimuovere né aggirare:
`backend/services/security_monitor.py` (alert su login falliti → `SystemLog`),
`backend/services/retention_service.py` (retention minima 365gg sui log di sicurezza),
`RevokedToken` (blacklist JWT al logout), middleware Origin/Referer sulle richieste mutanti.

L'audit di sicurezza più recente è in `docs/SECURITY_AUDIT_2026-05-30.md`.

---

## Panoramica del progetto

MaintAI è un sistema di gestione manutenzione industriale AI-powered (CMMS) per impianti
manifatturieri, energetici e portuali. UI bilingue **italiano (default) / inglese**.

**Utenti target e ruoli JWT** (`Utente.ruolo`):
- `superadmin` — gestione clienti/tenant, configurazione moduli globale, bypass RBAC
- `responsabile` — responsabile manutenzione / planner: pianifica, coordina, visione globale
- `tecnico` — tecnico sul campo: riceve il piano, esegue, usa il supporto AI

**Funzionalità in produzione:**
1. Gerarchia Siti → Impianti → Asset con dati tecnici, documenti, note, procedure, QR code
2. Ticket: 5 stati (Aperto / Pianificato / In corso / Chiuso / Eliminato), 5 tipi (BD / PM / CM / ISP / MOD-STR), ore uomo (auto = durata × tecnici, o manuale), allegati, ricambi, rapportino PDF con firma, paginazione server-side, export Excel
3. **Pianificazione Felix** — motore deterministico (auto-scheduler) + motore GPT + Felix Agent, viste Gantt/Kanban/Calendario, storico piani con deautorizzazione, rolling 7-day, replanning adattivo, suggerimenti opportunistici
4. Sessione diagnostica AI guidata (RCA interattiva) + Failure Intelligence Engine (FMECA)
5. Caricamento manuali PDF → estrazione automatica piano manutenzione (`/piani`)
6. Dashboard KPI in tempo reale (polling 30s) con grafici Recharts + Centro di Controllo geografico (`/controllo`)
7. Kanban board ticket drag-and-drop (`@dnd-kit`)
8. Email-to-Ticket via IMAP polling — **disattivato di default** (modulo `email_to_ticket`)
9. Gestione tecnici con assenze e orari + `/risorse/personale` (griglia settimanale, conflitti con ticket pianificati)
10. Magazzino ricambi con giacenza/prenotato/disponibile e vincolo di pianificazione
11. Manutenzione su condizione (letture `AssetConditionReading`, trigger calendario/condizione)
12. Scadenziario manutenzioni + scadenziario attestati/certificazioni tecnici (compliance)
13. Report economico, 5 agenti AI esperti (topbar) con tracciamento costo in EUR
14. App mobile `/m` (shell dedicata, PWA) e app desktop Tauri con auto-update
15. Prototipo visore XR (`/xr`, WebXR immersive-ar su Meta Quest 3)
16. Log di sistema persistenti in DB (`SystemLog`), multi-tenant con isolamento JWT

---

## Comandi sviluppo

### Backend (FastAPI + Python 3.11/3.13)
```bash
# Avvia server di sviluppo (sempre dalla root del repo)
python -m uvicorn backend.main:app --reload

# Test (SQLite in-memory, rate limiter disabilitato dalla conftest)
python -m pytest backend/tests/ -q
python -m pytest backend/tests/test_planner_engine.py -q     # singolo file

# Migrazioni DB
alembic upgrade head
alembic revision --autogenerate -m "descrizione"
```

I test richiedono `JWT_SECRET` e `ENCRYPTION_KEY` in ambiente (vedi `.github/workflows/ci.yml`
per i valori fittizi usati in CI).

### Frontend (Next.js 16 + TypeScript)
```bash
cd frontend
npm run dev            # dev su porta 3000 (copia prima gli asset pdf.js)
npm run build          # build produzione (gate TypeScript attivo: ignoreBuildErrors=false)
npm run lint           # ESLint — deve restare a 0 errori (gate SEC-04)
npm run build:desktop  # static export per il packaging Tauri
npm run tauri:build    # build installer desktop

node scripts/i18n_missing_keys.mjs   # report stringhe senza traduzione EN
```

### Versionamento
```bash
python scripts/version_bump.py 3.3.3   # allinea backend, frontend, package.json,
                                       # tauri.conf.json, deploy-version.json, AGENTS.md, CLAUDE.md
```

### CI (GitHub Actions)
- `ci.yml` — pytest backend, build + lint frontend, SAST Semgrep (OWASP)
- `codeql.yml` — CodeQL su Python e TypeScript
- `security.yml` — audit dipendenze e secret scanning

---

## Architettura

### Stack tecnico
- **Frontend**: Next.js 16 App Router, React 19, TypeScript, Tailwind v4, shadcn/ui + Base UI, Recharts, @dnd-kit, TanStack Table, sonner, Leaflet, pdf.js
- **Backend**: FastAPI, SQLAlchemy 2 ORM, Alembic, Pydantic v2, slowapi, reportlab, segno
- **DB locale**: SQLite (`maintai.db` + `demo.db` per utenti demo)
- **DB cloud**: PostgreSQL su Render
- **Storage**: Supabase Storage (bucket **privato**) in cloud, `uploads/` in locale
- **AI**: OpenAI `gpt-4.1` (problem analysis) e `gpt-4.1-mini` (diagnostica, parsing manuali, agenti); Felix Agent su OpenAI Agents SDK
- **Deploy**: Vercel (frontend) + Render (backend) + Tauri 2 (desktop Windows)

### Data flow
```
Next.js Frontend (Vercel, porta 3000 in locale)
  → frontend/app/lib/api.ts
      timeout default: 30s
      timeout endpoint AI: 120s — /planning/generate: 240s (cold start Render + OpenAI)
  → FastAPI Backend (Render / porta 8000 in locale)
  → Services layer
  → SQLAlchemy ORM → PostgreSQL (Render) / SQLite (locale)
                ↕
          OpenAI API
          Open-Meteo API (previsioni meteo per vincoli asset)
          Nominatim (geocoding siti, Centro di Controllo)
          Supabase Storage (allegati, firme, documenti)
```

### Autenticazione
- **Cookie-first**: il JWT viaggia nel cookie HttpOnly `maintai_jwt`; `Authorization: Bearer`
  resta come fallback (usato dalla build **Tauri**, che non ha cookie cross-origin e salva il
  token in `localStorage` — vedi `isTauri()` / `getTauriToken()` in `api.ts`).
- Logout → il token finisce in `RevokedToken` (blacklist).
- Payload JWT: `sub`, `ruolo`, `tenant_id`, `is_demo`.

### Routing DB (multi-tenant + demo)
- `get_db` in `backend/core/dependencies.py` → se JWT ha `is_demo=True` usa `demo.db` (SQLite), altrimenti PostgreSQL
- Ogni tabella ha `tenant_id` FK; le query filtrano **sempre** per tenant
- SuperAdmin può impersonare un tenant via header `X-Tenant-Id`
- `check_tenant_ownership(db, Model, id, tenant_id)` prima di ogni accesso per id

### Struttura backend
```
backend/
  main.py                  — bootstrap: Alembic upgrade, init_db, _ensure_columns,
                             email poller, middleware (CORS, Origin/Referer, security headers),
                             mounting router core + router per modulo + duplicati sotto /v1
  core/
    config.py              — VERSION, BUILD_DATE, OPENAI_API_KEY/MODEL, init_backend()
    database.py            — engine, SessionLocal, DATABASE_URL, DEMO_DATABASE_URL
    dependencies.py        — get_db (routing demo/prod)
    security.py            — JWT (cookie-first), hashing, Fernet, get_current_tenant_id,
                             get_current_user_payload, require_superadmin, require_roles,
                             check_tenant_ownership, decode/resolve *_leniently (endpoint pubblici)
    modules.py             — MODULE_DEFINITIONS + risoluzione env / globale / per-tenant
    rate_limiter.py        — slowapi, key_func proxy-aware (TRUST_PROXY_HEADERS)
    file_validation.py     — validate_upload, validate_magic, safe_serving (anti stored-XSS)
    storage.py             — astrazione Supabase Storage / filesystem locale, anti path traversal
    logger_db.py           — log_to_db(), db_info(), db_error() → scrive in SystemLog
    logging_config.py      — setup logging Python standard + redazione dati sensibili
    exceptions.py          — AppError, handler FastAPI
    init_db.py             — bootstrap tabelle e seed
    failure_seed.py        — knowledge base FMECA iniziale
  db/
    modelli.py             — TUTTI i modelli ORM (file unico, ~35 tabelle)
  schemas/                 — Pydantic (ticket, siti, impianti, ricambi, tenant,
                             piano_manutenzione, schemas.py generico)
  repositories/            — accesso dati per asset, impianti, siti, tecnici, ticket
  api/routes/              — un modulo per dominio (37 router)
  services/
    auto_scheduler.py          — motore deterministico di default (saturazione ore, no SLA)
    auto_scheduler_bridge.py   — adattatore ORM → auto_scheduler → plan_json
    planner_engine.py          — motore deterministico "puro" (dataclass, no ORM, testabile);
                                 usato come baseline da Felix Agent e dal replanning
    planner_engine_bridge.py   — adattatore ORM → PlannerEngine → plan_json
    rolling_planner_engine.py  — orizzonte mobile 7gg: readiness gate, freeze zone,
                                 insertion score, disruption cost, PM protection (docs/rolling.md)
    opportunistic_service.py   — top-5 PM inseribili in slot liberi (insertion_score)
    adaptive_estimator.py      — fattore correttivo durata da storico PlannerFeedback
    scheduler_service.py       — logica schedulazione legacy
    ai_planner_service.py      — motore GPT (Felix) + collect_planning_context + efficiency
    ai/
      openai_service.py        — client e modello OpenAI centralizzati
      pseudonymizer.py         — pseudonimizzazione reversibile (obbligatoria)
      prompt_security.py       — policy input non fidato, wrap_untrusted
      anonymization_service.py — anonimizzazione dati sensibili
      planning_agent_service.py— Felix Agent (OpenAI Agents SDK, tool loop)
      agents_service.py        — 5 agenti esperti + stima costo EUR → AiUsageLog
      diagnostic_service.py    — sessione diagnostica RCA interattiva
      manuals_ai_service.py    — estrazione piano manutenzione dai manuali
      problem_analysis_service.py — analisi guasti avanzata (gpt-4.1)
    failure_engine.py          — matching sintomi → failure mode (FMECA)
    condition_maintenance_service.py — trigger calendario/condizione, running hours
    auto_ticket_service.py     — generazione automatica ticket da scadenze/condizioni
    ricambi_service.py         — giacenza/prenotato/disponibile + vincolo pianificazione
    man_hours.py               — unica implementazione di "ore uomo = durata × tecnici"
    ticket_pdf_service.py      — rapportino intervento PDF con firma (reportlab)
    qr_service.py              — QR asset (segno)
    pdf_service.py             — parsing PDF manuali
    weather_service.py         — Open-Meteo API, WeatherData
    email_poller.py            — IMAP polling ogni 5 min → crea Ticket
    security_monitor.py        — rilevamento login falliti → alert SystemLog
    retention_service.py       — retention log (minimo 365gg per NIS2/ISO 27002)
  tests/                       — ~35 file pytest (planner, RBAC, tenant filter, upload
                                 security, pseudonimizzazione, moduli, ricambi, …)
```

### Struttura frontend
```
frontend/app/
  layout.tsx / RootShell.tsx — shell con sidebar (nav dinamica per ruolo + moduli),
                               topbar (agenti AI, notifiche, lingua, tema), bootstrap locale
  lib/
    api.ts                 — fetch client, cookie/Bearer (Tauri), timeout adattivo per endpoint
    auth.tsx               — AuthContext, useAuth
    modules.ts             — ModuleId + stato moduli lato client
    navigation.tsx         — voci di menu con `module`/`adminOnly`/`superadminOnly`
    i18n/                  — I18nProvider, dictionary, domain labels
    toast.ts               — notify.error/success/info/warning (sonner)
    datetime.ts, assetStatus.ts, qrDecode.ts, rapportino.ts
    version.ts             — VERSION / BUILD_DATE / DEPLOY_VERSION
  globals.css              — design system: CSS custom properties, dark/light via [data-theme]
  components/
    ui/                    — shadcn/ui (button, badge, card, dialog, data-table…)
    KanbanBoard, StatusToggle, UploadAllegati, AssenzeModal, QrScanner, AssetQRCode,
    SignaturePad, FirmaRapportinoModal, VoiceRecorder, WeatherWidget, AgentsBar,
    GuideBot, NotificationPanel, TenantContextSwitcher, EmergencyMap, ParetoChart,
    GlobalQuickTicket, QuickTicketModal, RicambiTicket, InstallPrompt, …
  dashboard/               — KPI, grafici Recharts
  controllo/               — Centro di Controllo: mappa Google Maps siti/impianti
                             (fallback Leaflet/OSM senza API key), KPI supervisione
  ticket/                  — tabella paginata server-side, modal dettaglio, kanban
  planning/                — Pianificazione Felix
    page.tsx               — pagina principale (fetch, stati, conferma, storico)
    types.ts               — types condivisi + helper (timeToCol, tipoStyle)
    components/            — GanttGiornaliero (18 slot 08:00-17:00), KanbanSettimanale,
                             CalendarioMensile, BadgeEfficienza, PannelloMotivazioni,
                             StoricoPiani
  asset/ assets/ impianti/ — anagrafica e dettaglio asset
  storico/[asset_id]/      — storico interventi per asset
  tecnici/ risorse/personale/ — anagrafica tecnici, assenze, griglia settimanale
  magazzino/               — ricambi: giacenza, movimenti, proposte d'acquisto
  piani/                   — piani di manutenzione (upload PDF + estratti);
                             /piani-manutenzione è un redirect
  manuali/                 — upload e consultazione manuali
  scadenze/ condizioni/ compliance/ — scadenziario, letture condizione, attestati
  report/economico/        — report economico (adminOnly)
  diagnostic/              — sessione diagnostica AI / RCA
  m/                       — app mobile: shell dedicata con bottom tab bar
                             (home, ticket, nuovo, piano, diagnosi, profilo);
                             /mobile è un redirect permanente a /m
  check/[token]/           — check di primo livello **pubblico** via QR (senza auth)
  print/asset-qr/          — stampa etichette QR asset
  xr/                      — prototipo visore XR (WebXR immersive-ar, Meta Quest 3):
                             QR asset → manuale PDF su pannello agganciato alla testa.
                             Installabile sul Quest come web app a sé
                             (/xr-manifest.webmanifest, id maintai-xr-viewer).
                             Modulo `xr_viewer`. Vedi docs/XR_PROTOTIPO.md
  admin/
    funzionalita/          — configurazione moduli globale + per tenant (superadmin)
    tenants/               — gestione clienti (superadmin)
    utenti/                — gestione utenti
    bulk-import/           — import massivo
    logs/                  — visualizza SystemLog
    email/                 — configurazione IMAP
  profilo/                 — profilo utente
```

---

## Sistema moduli (pagina Funzionalità)

`backend/core/modules.py` decide quali moduli sono attivi. Tre livelli, in ordine:

1. **env + `default_enabled`** nelle `MODULE_DEFINITIONS` → baseline
2. **configurazione globale** salvata dal superadmin → tabella `global_module_config`
   (una riga). Prima stava in `backend/modules_state.json`: su Render il filesystem è
   effimero, quindi ogni deploy azzerava la configurazione. Il file resta letto come
   sorgente legacy/bootstrap finché non esiste la riga in DB.
3. **override per tenant** → tabella `tenant_module_config` (una riga per tenant)

**Il globale è un kill-switch**: i moduli di un tenant sono intersecati con quelli globali,
quindi un modulo spento globalmente non è attivabile per singolo cliente. La UI lo dichiara
(badge *spenta globalmente* + avviso al salvataggio).

**Le configurazioni salvate non sono whitelist**, ma decisioni esplicite:
`{"enabled": [...], "known": [...]}` dove `known` è l'elenco dei moduli esistenti al
momento del salvataggio. Un modulo introdotto **dopo** non ha una decisione e ricade sul
livello superiore. Regola da non violare: aggiungendo un modulo nuovo alle
`MODULE_DEFINITIONS` non serve toccare le config salvate — se torni alla whitelist, ogni
modulo nuovo resta spento per sempre e invisibile (bug 2026-07-26, pagina `/xr`).

Le righe nel vecchio formato (lista nuda) sono ancora lette: i moduli assenti ricadono sul
default, perché non è possibile distinguere "spento per scelta" da "non esisteva ancora".
Uno spegnimento voluto va rifatto una volta e dal salvataggio successivo persiste.

### Gating dei router

In `backend/main.py`:
- `_CORE_ROUTERS` (health, auth, modules, agents) sono **sempre** montati.
- Gli altri passano da `_include_module_router(router, module_id)` → dipendenza
  `_require_module_enabled` che risponde **404** se il modulo è spento (globalmente o per
  quel tenant). Il superadmin non resta mai chiuso fuori da `tenant_admin`.
- Un sottoinsieme di router è montato anche sotto `/v1` per la futura migrazione del
  frontend; entrambi i path restano attivi.

**Aggiungere un modulo**: definirlo in `MODULE_DEFINITIONS`, registrare il router in
`_MODULE_ROUTERS`, aggiungere `ModuleId` in `frontend/app/lib/modules.ts` e la voce in
`navigation.tsx` con `module: "<id>"`. Non toccare le configurazioni salvate.

### Moduli esistenti

`dashboard`, `assets`, `technicians`, `tickets`, `planning`, `diagnostic_ai`,
`maintenance_plans`, `manuals`, `deadlines`, `condition_maintenance`, `spare_parts`,
`compliance`, `economic_reports`, `emergency`, `control_center`, `system_logs`,
`bulk_import`, `tenant_admin`, `user_admin`, `mobile_app`, `xr_viewer`, `weather`,
`desktop_updates`, `email_to_ticket` (default OFF), `guide_ai` (default OFF),
`agent_planner`, `agent_rca`, `agent_cost_controller`, `agent_kpi`, `agent_strategy`.

Gli agenti AI sono gated **dentro** gli endpoint (`is_module_enabled_for_tenant`), non dal
router, perché condividono un unico `agents_router`.

---

## Pianificazione Felix — dettaglio

### Motori intercambiabili (`POST /planning/generate`, campo `mode`)

| `mode` | Motore | Velocità | Requisiti |
|---|---|---|---|
| `"deterministic"` / `"auto"` (default) | `auto_scheduler` via `auto_scheduler_bridge` | istantaneo | nessuno |
| `"ai"` | OpenAI GPT (`ai_planner_service`) | 30-120s | `OPENAI_API_KEY` + `AI_PLANNING_ENABLED=true` |
| `"agent"` | Felix Agent (`ai/planning_agent_service.py`, OpenAI Agents SDK) | 30-120s | come sopra + pacchetto `openai-agents` |

Qualsiasi valore diverso da `"ai"`/`"agent"` ricade sul deterministico.

**`auto_scheduler`** (motore di default): satura le ore disponibili dei tecnici, esclude
sabato e domenica, niente overbooking né straordinari (a meno di `allow_overtime`, che
sposta la fine giornata da 17 a 21), 100% deterministico e ripetibile. Vedi
`Algoritmo planning.md`.

**`PlannerEngine`** (`planner_engine.py`) resta il motore "puro" testabile: nessun ORM,
solo dataclass. È la **baseline di Felix Agent** e il motore usato dal replanning adattivo
(`POST /planning/replanning`). Pesi per tipo: BD=1000, CM=200, PM=100, MOD-STR=80, ISP=50.

**Felix Agent**: agente tool-loop che parte dal piano baseline del `PlannerEngine`, lo
migliora (meteo, logistica, bilanciamento PM/CM, buffer reattivo) e si auto-valuta con il
tool `valuta_piano` (vincoli hard + efficiency score). I tool operano solo su un contesto
in-memoria pre-filtrato per tenant (nessun accesso DB dall'LLM); i dati sono pseudonimizzati
e il tracing SDK è disabilitato. In caso di errore degrada al piano deterministico con
warning (`plan_metadata.agent_fallback=true`).

### Altri endpoint di pianificazione
- `POST /planning/move-ticket` — spostamento manuale di un WO nel piano
- `POST /planning/evaluate` — valuta un piano modificato a mano
- `POST /planning/confirm/{plan_id}` / `POST /planning/deauthorize/{plan_id}`
- `GET /planning/current` · `GET /planning/status` · `GET /planning/history`
- `GET /planning/rolling-analysis` — analisi a orizzonte mobile 7gg (`docs/rolling.md`):
  readiness gate, freeze zone (FROZEN_24 / PROTECTED_48 / FLEXIBLE_72 / DYNAMIC_168),
  insertion score, disruption cost, PM protection, KPI rolling.
  ⚠️ Alcuni campi non esistono nel DB e sono derivati da **proxy documentati** in cima al
  modulo: quando il modello verrà esteso vanno sostituiti, non estesi.
- `GET /planning/opportunistic` — top-5 PM inseribili negli slot liberi
- `POST /planning/replanning` — replanning adattivo su orizzonte, via `PlannerEngine`

### Formato `plan_json` (identico per tutti i motori)
```json
{
  "planned_workorders": [
    {
      "wo_id": 42,
      "technician_id": 3,
      "planned_date": "2026-04-07",
      "time_slot": "08:00-10:00",
      "planned_start_time": "08:00",
      "planned_end_time": "10:00",
      "duration_hours": 2.0,
      "motivation": "...",
      "warnings": [],
      "is_continuation": false,
      "parent_wo_id": null
    }
  ],
  "deferred_workorders": [{"wo_id": 5, "reason": "..."}],
  "fermo_assets": [{"asset_id": 1, "triggered_by_wo_id": 42}],
  "global_warnings": [],
  "efficiency_score": 78,
  "efficiency_breakdown": {"copertura_backlog": 85, "utilizzo_tecnici": 70, ...},
  "efficiency_motivations": [{"componente": "...", "valore": 78, "target": 85, ...}]
}
```

### Conferma piano (`POST /planning/confirm/{id}`)
- Aggiorna **solo** ticket esistenti: `stato → "Pianificato"`, `tecnico_id`, `planned_start`, `planned_finish`
- **NON crea nuovi record Ticket**
- Asset con `fermo_on_schedule=True` → stato asset `stopped`
- Assegna `plan_number` progressivo per tenant (MAX+1)

### Stato Ticket → Aperto: azzera la pianificazione
Quando un ticket torna ad `"Aperto"` (via modal o toggle tabella), `planned_start` e
`planned_finish` vengono settati a `null` nel DB. Il ticket torna pianificabile dal motore.

### Sincronizzazione pagina planning
- `visibilitychange`: la pagina `/planning` ricarica i ticket ogni volta che l'utente torna in focus
- Pulsante `↻` per refresh manuale nell'header

---

## Modelli DB

Tutti i modelli stanno in `backend/db/modelli.py` (file unico). Tabelle principali:

`Tenant`, `Utente`, `RevokedToken`, `Sito`, `Impianto`, `Asset`, `Tecnico`, `TecnicoAssenza`,
`Ticket`, `TicketAllegato`, `Manuale`, `AttivitaManutenzione`, `PianoManutenzione`,
`AssetDocumento`, `AssetConditionReading`, `AnalisiGuasto`, `DiagnosticSession`,
`DiagnosticLearning`, `FailureMode`, `FailureAnalysis`, `Procedura`, `NotaAsset`,
`CheckPrimoLivello`, `Attestato`, `Ricambio`, `TicketRicambio`, `MovimentoRicambio`,
`GeneratedPlan`, `PlannerFeedback`, `EmailConfig`, `SystemLog`, `AiUsageLog`,
`TenantModuleConfig`, `GlobalModuleConfig`.

### Ticket — campi chiave

| Campo | Tipo | Note |
|---|---|---|
| `stato` | String | Aperto / Pianificato / In corso / Chiuso / Eliminato (`TicketStato` in `schemas/ticket.py`) |
| `tipo` | String | BD (Breakdown) / PM (Preventiva) / CM (Correttiva) / ISP (Ispezione) / MOD-STR (Modifica strutturale) |
| `priorita` | String | Alta / Media / Bassa |
| `durata_stimata_ore` | Float | usata dal planner per lo scheduling |
| `man_hours` + `man_hours_calculation_mode` | Float / `auto`\|`manual` | ore uomo; in `auto` = durata × tecnici, calcolata **solo** da `services/man_hours.py` |
| `planned_start` / `planned_finish` | DateTime | settati alla conferma del piano (o manualmente) |
| `tecnico_id` | FK | assegnato alla conferma |
| `is_continuation` / `parent_ticket_id` | Boolean / FK | frammento di WO splittato su più giorni |

### Asset — stati
DB e API usano `service` / `stopped` / `out of service`; la UI mostra
OPERATIVO / FERMO / GUASTO. La normalizzazione (inclusi i valori legacy italiani) è in
`frontend/app/lib/assetStatus.ts` — non reintrodurre confronti su stringhe italiane.

### GeneratedPlan — campi chiave

| Campo | Tipo | Note |
|---|---|---|
| `status` | String | draft / confirmed / deauthorized |
| `plan_number` | Integer | progressivo per tenant, assegnato alla conferma |
| `plan_json` | JSON | struttura plan_json completa |
| `confirmed_by` | String | username JWT di chi ha confermato |
| `deauthorized_by` | String | username di chi ha deautorizzato |
| `deauthorization_reason` | String | motivazione obbligatoria |

### Ricambi — vincolo di pianificazione
`disponibile = giacenza − prenotato` (prenotato = quantità impegnata da ticket
Pianificato/In corso). Con il modulo `spare_parts` attivo, un ticket con anche **un solo**
ricambio mancante o insufficiente **non è pianificabile**: viene deferito con proposta
d'acquisto. Logica in `services/ricambi_service.py`, tutte le query filtrate per tenant.

---

## Configurazione

### Variabili d'ambiente backend (`backend/.env` / Render)
```
# Obbligatorie
JWT_SECRET=...                         # firma JWT
ENCRYPTION_KEY=...                     # chiave Fernet (encrypt_data/decrypt_data)
DATABASE_URL=postgresql://...          # PostgreSQL Render
DEMO_DATABASE_URL=sqlite:///demo.db    # DB demo locale

# AI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
AI_PLANNING_ENABLED=false              # abilita mode="ai" / "agent"
AI_EUR_PER_USD=0.92                    # cambio per la stima costo agenti

# Rete / sicurezza
CORS_ORIGINS=https://maintai.vercel.app,https://...
FRONTEND_URL=https://maintai.vercel.app
APP_BASE_URL=https://maintai.vercel.app   # base dei QR asset
ENV=production                            # (o RENDER/VERCEL impostati dalla piattaforma)
COOKIE_SECURE=                            # default: true in produzione
COOKIE_SAMESITE=lax
TRUST_PROXY_HEADERS=1                     # 0 se l'app NON è dietro reverse proxy
ACCESS_TOKEN_EXPIRE_MINUTES=...

# Storage
SUPABASE_URL=... / SUPABASE_SERVICE_KEY=... / SUPABASE_BUCKET=...   # bucket PRIVATO

# Altro
LOG_RETENTION_DAYS=365                 # minimo di compliance, non abbassabile sotto 365
MAINTAI_MODULES_STATE_FILE=...         # sorgente legacy config moduli
MAINTAI_MODULE_<ID>=true|false         # override per singolo modulo
SEED_ADMIN_PASSWORD / SEED_TECNICO_PASSWORD
SCHEDULER_ENFORCE_SKILL / SCHEDULER_ENFORCE_MATERIALS
```

### Variabili d'ambiente frontend (Vercel)
```
NEXT_PUBLIC_API_BASE=https://maintai-v3.onrender.com
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...   # opzionale — mappa Google del Centro di Controllo
                                      # (/controllo); senza key si usa Leaflet/OpenStreetMap.
                                      # Limitare la key per referrer HTTP nella console Google Cloud.
DESKTOP_BUILD=true                    # solo per il build statico Tauri
```

I domini esterni ammessi (Google Maps, Supabase, backend) sono elencati nella **CSP** in
`frontend/next.config.ts`: aggiungendo un servizio esterno va aggiornata anche lì, altrimenti
le chiamate vengono bloccate in produzione.

---

## Convenzioni di codice

- Tutti gli import backend usano il prefisso `backend.` (es. `from backend.core.database import ...`)
- I log persistenti vanno scritti con `log_to_db()` / `db_info()` / `db_error()` da `backend.core.logger_db`
- Il Python logging standard (`logger.info/error`) va **sempre** in aggiunta, non in sostituzione
- Ogni query su dati di tenant filtra per `tenant_id`; per accesso by-id usare `check_tenant_ownership()`
- Ogni nuovo endpoint che serve file passa da `file_validation.safe_serving()`; niente static mount in produzione
- Ogni nuova chiamata OpenAI passa da `Pseudonymizer` + `wrap_untrusted` (il test di guardia fallisce altrimenti)
- Ore uomo: unica implementazione in `services/man_hours.py`, mai duplicare la formula
- Design system frontend: dark industrial `#0a0f1e` background, `#111827` card, `#1f2937` elevated
- Colori per tipo ticket: BD=rosso `#ef4444`, PM=verde `#22c55e`, CM=ambra `#f59e0b`, ISP=blu `#3b82f6`, MOD-STR=viola `#8b5cf6`
- shadcn/ui Dialog: usare sempre `showCloseButton={false}` e aggiungere un singolo pulsante × custom
- Dialog z-index: `z-[9999]` per popup, `z-[9998]` per overlay (il planning usa z-index:1000)
- `npm run lint` deve restare a 0 errori e il build TypeScript non ignora gli errori

---

## Internazionalizzazione (IT / EN)

L'interfaccia è bilingue **italiano (default) / inglese**. Il selettore lingua è
nella topbar desktop, nell'header della shell mobile `/m` e nella pagina di login;
la scelta è salvata in `localStorage` (`maintai_locale`) e applicata su `<html lang>`
dallo script di bootstrap in `app/layout.tsx`, prima del primo paint.

**Il database non è toccato**: stati, tipi e priorità restano in italiano su DB e
API. Si traduce solo l'etichetta mostrata.

### File

```
frontend/app/lib/i18n/
  index.tsx        — I18nProvider, useT(), useI18n(), tn(), getLocaleTag()
  dictionary.ts    — mappa IT → EN (unico file da estendere)
  domain.ts        — etichette dei valori di dominio (stato/tipo/priorità/ruolo…)
frontend/app/components/LanguageSwitcher.tsx
frontend/scripts/i18n_missing_keys.mjs   — report delle stringhe senza traduzione
```

### Regole

1. **La stringa italiana è la chiave.** `t("Nuovo Ticket")` restituisce l'italiano
   in `it` e cerca il dizionario in `en`. Una chiave assente resta in italiano:
   degrado morbido voluto, mai una chiave grezza a schermo.
2. **Nel JSX si usa `useT()`** (nel codice generato la variabile si chiama `tr`,
   perché `t` è già usato ovunque come parametro di callback sui ticket).
   Per **toast, `confirm()` e messaggi non renderizzati** si usa `tn()`: è stabile,
   non entra nelle dipendenze degli hook e non fa rieseguire le fetch al cambio lingua.
3. **Interpolazione, mai concatenazione**: `t("Ticket #{id} creato", { id })`.
   L'ordine delle parole cambia tra le lingue.
4. **Valori di dominio**: usare `labelStato` / `labelPriorita` / `labelRuolo`… da
   `i18n/domain.ts`. Su `<select>` il `value` resta italiano e si traduce solo il
   testo dell'`<option>` — un `<option>` **senza** `value` esplicito invierebbe al
   backend il testo tradotto.
5. **Mai avvolgere in `t()`** stringhe usate in confronti (`stato === "Aperto"`),
   id/slug, chiavi di oggetto, classi CSS o percorsi API.
6. **Date e numeri**: `getLocaleTag()` al posto di `"it-IT"` hardcoded
   (`en` → `en-GB`, quindi gg/mm/aaaa anche in inglese).

### Terminologia

L'inglese segue il lessico manutentivo (CMMS / EN 13306), non la traduzione
letterale: *Fermo* → **Downtime**, *Guasto* → **Failure/Breakdown**, *Intervento* →
**Work order**, *Pianificazione* → **Scheduling**, *Giacenza* → **Stock on hand**,
*Scorta* → **Reorder level**, *Attestato* → **Certification**, *Scadenziario* →
**Due Schedule**, *DPI* → **PPE**. Le sigle BD/PM/CM/ISP restano invariate.

### Aggiungere testo nuovo

Scrivere la stringa in italiano dentro `t()`/`tn()`, poi aggiungere la voce in
`dictionary.ts`. Per verificare la copertura:

```bash
cd frontend && node scripts/i18n_missing_keys.mjs
```

Restano volutamente fuori dal dizionario le voci identiche nelle due lingue
(MTBF, OEE, km/h, MaintAI, Felix, BD/PM/CM…): il fallback le rende già correttamente.

**Non ancora tradotti**: i `metadata` statici di `app/xr/layout.tsx` (title e
description della pagina XR, risolti lato server) e i contenuti che arrivano dal
backend (log di sistema, motivazioni del planner, risposte AI).

---

## Livello commerciale SaaS (piani, quote, abbonamenti)

Studio completo e istruzioni di prova: [`docs/SAAS_SELF_SERVICE.md`](docs/SAAS_SELF_SERVICE.md).
Prova rapida senza avviare nulla: `python scripts/demo_saas.py`.

**Dove sta cosa.** Il *catalogo* (quali piani esistono, cosa includono, quanto costano)
è nel codice — `backend/core/plans.py`, come le `MODULE_DEFINITIONS`. Il DB conserva solo
ciò che è dato del cliente: `subscriptions` (piano, stato, periodo, add-on),
`subscription_events`, `usage_counters`, `auth_tokens`, `onboarding_progress`.
Mai mettere un piano in tabella: è una decisione di prodotto, deve passare dalla code review.

**Chi decide.** Solo `backend/services/billing/entitlement_service.py`. Ogni endpoint che
crea una risorsa a quota chiama `require_capacity(db, tenant_id, METRIC, 1)` **prima** di
scrivere; il frontend può anticipare lo stato per non far compilare form destinati a
fallire, ma non decide nulla.

| Concetto | Dove |
|---|---|
| Piano, quote, add-on del tenant | `resolve_entitlements(db, tenant_id)` |
| Verifica capienza | `require_capacity(...)` → 402 con metrica/consumo/limite |
| Diritto di scrittura | `require_write_access(...)` / dependency `enforce_write_access` |
| Consumo AI (metrica di flusso) | `record_usage(db, tid, METRIC_AI_CALLS, 1)` |
| Transizioni di stato | solo `subscription_service.py` |
| Eventi dal provider | solo `webhook_service.process_event` |

**Metriche: stock vs flow.** Utenti, siti e asset si misurano con una `COUNT` sulla tabella
e non vanno mai memorizzati in `usage_counters`: un contatore per un dato derivabile è una
seconda verità che prima o poi diverge. `usage_counters` serve solo alle metriche di flusso
(chiamate AI/mese), che non sono ricostruibili dallo stato corrente.

**Il piano è il terzo livello del gate moduli**, non un sistema parallelo:

```
moduli effettivi = (globale ∩ piano) + decisioni tenant, il tutto intersecato col tetto
```

Aggiungere un secondo meccanismo di feature flag produrrebbe clienti che pagano una
funzione e non la vedono, senza che nessuna pagina di amministrazione sappia spiegare
perché. Vedi `effective_enabled_ids()` in `backend/core/modules.py`.

**Retrocompatibilità — regola da non violare.** Un tenant **senza riga in `subscriptions`**
è *grandfathered*: nessun limite, nessun tetto sui moduli, accesso pieno. Vale per tutti i
clienti creati a mano dal superadmin. Tutti i gate commerciali sono **fail-open**: se lo
stato non è leggibile, la richiesta passa. Bloccare un cliente pagante costa molto più che
lasciar passare una richiesta di troppo.

**Sola lettura, mai blocco.** Nessuno stato dell'abbonamento toglie l'accesso ai dati: il
peggio è la sola lettura, che lascia intatti letture, export, fatture e `/billing`. Un
cliente moroso deve poter rientrare in regola e portare via i propri dati.

**Provider di pagamento.** `BILLING_PROVIDER=local` (default) usa un checkout simulato che
produce eventi con la stessa forma di quelli Stripe e li fa passare per lo stesso
`process_event`: ciò che si prova in locale è la strada del pagamento vero.
`BILLING_PROVIDER=stripe` richiede `pip install stripe` e i price id in env; da lì Stripe è
autoritativo e le colonne locali sono solo uno specchio aggiornato dai webhook.

**Idempotenza dei webhook.** La garanzia è il vincolo `UNIQUE(provider_event_id)` su
`subscription_events`, non un lock applicativo. Rimuoverlo significa riapplicare pagamenti e
disdette quando il provider ritenta la consegna (Stripe garantisce *at-least-once*).

**Registrazione pubblica.** `SELF_SERVICE_SIGNUP_ENABLED` è **spento di default in
produzione**: aprire la creazione di tenant a chiunque è una decisione commerciale. Fuori
produzione i token di verifica tornano nella risposta (`dev_verification_token`) per poter
provare senza SMTP — mai in produzione.

---

## Migrazioni DB

Alembic è configurato con `batch_alter_table` per compatibilità SQLite.
La funzione `_ensure_columns()` in `backend/main.py` è un fallback idempotente
che aggiunge colonne mancanti via DDL diretto (usata su deploy cloud se Alembic fallisce).
Ogni deploy esegue `alembic upgrade head` automaticamente all'avvio.

Aggiungendo una colonna: modello in `db/modelli.py` → `alembic revision --autogenerate`
→ verifica del file generato (l'autogenerate su SQLite non vede tutto) → se la colonna è
critica al boot, aggiungerla anche a `_ensure_columns()`.

---

## Deploy

- **Backend** — Render (`render.yaml`): `pip install -r backend/requirements.txt`, avvio
  `uvicorn backend.main:app --no-server-header`, health check su `/health`, autoDeploy da
  `main`, `buildFilter` limitato a `backend/**`, `alembic/**`, `requirements.txt`.
- **Frontend** — Vercel (`vercel.json`), build da `frontend/`.
- **Desktop** — Tauri 2 (`frontend/src-tauri/`), build statico con `DESKTOP_BUILD=true`;
  auto-update servito dal router `desktop_update` (modulo `desktop_updates`,
  manifest `backend/update_manifest.json`). Vedi `DESKTOP.md`.
- Le dipendenze Python sono **pinnate** per l'audit di sicurezza: aggiornarle una alla
  volta con la motivazione nel commento, come già fatto in `backend/requirements.txt`.

---

## Documentazione di riferimento

| File | Contenuto |
|---|---|
| `docs/architecture.md` | architettura estesa e workaround espliciti |
| `Algoritmo planning.md` | specifica dell'auto-scheduler deterministico |
| `docs/planner_design.md`, `docs/planning_rules.md`, `docs/planning_directive.md` | regole e vincoli di pianificazione |
| `docs/planning_explainability.md` | spiegabilità del piano e motivazioni |
| `docs/rolling.md` | orizzonte mobile 7 giorni |
| `docs/llm_planning_prompt.md` | prompt del motore GPT |
| `docs/XR_PROTOTIPO.md` | prototipo visore XR |
| `docs/deploy_cloud.md` | procedura di deploy |
| `docs/SECURITY_*` | linee guida, checklist, addendum MaintAI, audit |
| `CHANGELOG.md`, `ROADMAP_PMI.md` | storico e roadmap |
| `DESKTOP.md` | build e distribuzione dell'app Tauri |

---

## Known Issues / Comportamenti noti

- **Render free tier**: il backend può impiegare 30-60s per svegliarsi dal cold start.
  I timeout del client sono 240s per `/planning/generate`, 120s per gli altri endpoint AI e
  per firma/rapportino, 30s per il resto.
- **Rate limiter in-memory**: i contatori slowapi sono per-processo e si azzerano al restart;
  con N worker il limite effettivo è ~N volte quello dichiarato. Il deploy attuale usa un
  singolo worker. Per scalare serve `Limiter(storage_uri="redis://...")`.
- **security_monitor in-memory**: stessa limitazione, accettata e documentata nel modulo.
- **PlannerEngine skill check**: i tecnici usano competenze job-skill (Meccanico,
  Elettricista). Il bridge aggiunge automaticamente PM/CM/BD come competenze implicite a
  ogni tecnico attivo, così il motore deterministico non scarta i ticket per `REASON_NO_SKILL`.
- **Rolling planner con campi proxy**: `rolling_planner_engine.py` deriva da campi esistenti
  alcuni attributi non presenti nel DB. I proxy sono elencati in cima al file e vanno
  sostituiti — non estesi — quando il modello verrà ampliato.
- **`/scheduler`** → redirect a `/planning`; **`/mobile`** → redirect a `/m`;
  **`/piani-manutenzione`** → redirect a `/piani`. Nessuna logica propria.
- Il `plan_json` è salvato come `JSON` su PostgreSQL e come `TEXT` su SQLite (serializzato
  automaticamente da SQLAlchemy).
- `frontend/package.json` contiene `overrides` per `postcss` e `sharp`: sono il fix alle
  advisory high che `npm audit fix` non risolve perché sono dipendenze dirette di Next.
  Rimuoverli solo quando Next dichiarerà versioni non vulnerabili.
