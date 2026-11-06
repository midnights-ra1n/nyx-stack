import { ArrowPathIcon, Cog6ToothIcon, EllipsisHorizontalIcon, MagnifyingGlassIcon, PencilSquareIcon, ChevronRightIcon, ChevronUpDownIcon } from "@heroicons/react/24/outline"
import { createRoot } from "react-dom/client"
import { type ReactNode, createContext, useContext, useEffect, useState, useSyncExternalStore } from "react"
import { Button, ErrorNote, type Icon, Input, Tabs } from "./components"
import { api, AUTH_LOST, markUrl, REFRESH, setRefresh, useApi, useOnline, useRefresh } from "./lib"

// Router: the app has few, flat routes; history API is all it needs.
const subscribe = (l: () => void) => { addEventListener("popstate", l); return () => removeEventListener("popstate", l) }
export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname)
export const navigate = (to: string) => { history.pushState(null, "", to); dispatchEvent(new PopStateEvent("popstate")) }

export function Link({ to, className, children, ...p }: { to: string; className?: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={to} {...p} className={className} onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate(to) } }}>{children}</a>
}

export interface NavItem { to: string; label: string; icon: Icon; badge?: number }
export interface NavConfig {
  name: string
  /** Which of the two servers this is, under the logo. */
  role: string
  groups: { label: string; items: NavItem[] }[]
  /** Four bottom-bar tabs on phones; the rest goes to the "More" sheet. */
  tabs: string[]
  footer?: ReactNode
}

const Logo = ({ className = "size-8" }: { className?: string }) => <img src={markUrl()} alt="" className={className} />

const isActive = (path: string, to: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`))

function Search() {
  const [q, setQ] = useState("")
  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`) }} className="relative max-lg:hidden">
      <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-2.5 size-5 text-fg3" aria-hidden />
      <input aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="h-9 max-sm:h-11 w-full rounded-control border border-line2 bg-raised pl-10 pr-4 placeholder:text-fg3" />
    </form>
  )
}

function SideEntry({ item, path }: { item: NavItem; path: string }) {
  const active = isActive(path, item.to), I = item.icon
  return (
    <Link to={item.to} title={item.label} aria-current={active ? "page" : undefined} className={`flex h-9 max-sm:h-11 items-center gap-3 rounded-control px-3 max-lg:justify-center ${active ? "bg-accent-soft text-accent" : "text-fg2 hover:bg-raised hover:text-fg"}`}>
      <I className="size-5 shrink-0" aria-hidden />
      <span className="flex-1 max-lg:sr-only">{item.label}</span>
      {!!item.badge && <span className="rounded-full bg-crit-soft px-2 text-xs leading-5 text-crit max-lg:hidden">{item.badge}</span>}
    </Link>
  )
}

/** 248 px sidebar, 72 px icon rail from 640 to 1023 px. */
function Sidebar({ nav, path }: { nav: NavConfig; path: string }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-10 flex w-[248px] flex-col gap-7 border-r border-line bg-sidebar px-4 py-6 max-lg:w-[72px] max-lg:px-3 max-sm:hidden">
      <Link to="/" className="flex items-center gap-3 max-lg:justify-center"><Logo /><span className="flex flex-col max-lg:sr-only"><span className="text-lg leading-6 font-medium">{nav.name}</span><span className="text-xs text-fg2">{nav.role}</span></span></Link>
      <Search />
      <nav className="flex flex-1 flex-col gap-7 overflow-y-auto" aria-label="Main">
        {nav.groups.map((g) => (
          <div key={g.label} className="flex flex-col gap-1">
            <div className="px-3 pb-1 text-xs text-fg3 max-lg:sr-only">{g.label}</div>
            {g.items.map((i) => <SideEntry key={i.to} item={i} path={path} />)}
          </div>
        ))}
      </nav>
      <div className="flex flex-col gap-3">
        <SideEntry item={{ to: "/settings", label: "Settings", icon: Cog6ToothIcon }} path={path} />
        {nav.footer && <div className="border-t border-line px-3 pt-3 max-lg:hidden">{nav.footer}</div>}
      </div>
    </aside>
  )
}

function BottomBar({ nav, path, onCustomize }: { nav: NavConfig; path: string; onCustomize?: () => void }) {
  const [more, setMore] = useState(false)
  const items = nav.groups.flatMap((g) => g.items)
  const tabs = nav.tabs.flatMap((to) => items.filter((i) => i.to === to))
  const rest = [...items.filter((i) => !nav.tabs.includes(i.to)), { to: "/settings", label: "Settings", icon: Cog6ToothIcon }]
  const Tab = ({ label, icon: I, active, badge, ...p }: { label: string; icon: Icon; active: boolean; badge?: number } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...p} aria-current={active ? "page" : undefined} className={`relative flex flex-1 flex-col items-center justify-center gap-1 text-xs ${active ? "text-accent" : "text-fg2"}`}>
      <span className={`flex h-[30px] w-14 items-center justify-center rounded-full ${active ? "bg-accent-soft" : ""}`}><I className="size-6" aria-hidden /></span>
      {label}
      {!!badge && <span className="absolute top-1 left-1/2 ml-1 flex size-5 items-center justify-center rounded-full bg-crit-soft text-xs text-crit">{badge}</span>}
    </button>
  )
  return (
    <>
      {more && (
        <>
          <div className="fixed inset-0 z-20 bg-black/60 sm:hidden" onClick={() => setMore(false)} />
          <div className="fixed inset-x-2 bottom-[calc(72px+env(safe-area-inset-bottom))] z-30 rounded-panel border border-line2 bg-surface p-2 sm:hidden">
            {rest.map((i) => { const I = i.icon; return <Link key={i.to} to={i.to} onClick={() => setMore(false)} className="flex h-11 items-center gap-4 rounded-control px-4 text-base text-fg"><I className="size-5 text-fg2" aria-hidden />{i.label}</Link> })}
            {onCustomize && <button className="flex h-[52px] w-full items-center gap-4 border-t border-line px-3 text-base text-accent" onClick={() => { setMore(false); onCustomize() }}><PencilSquareIcon className="size-5" aria-hidden />Customize screen</button>}
          </div>
        </>
      )}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex h-[calc(64px+env(safe-area-inset-bottom))] border-t border-line bg-sidebar pb-[env(safe-area-inset-bottom)] sm:hidden">
        {tabs.map((t) => <Tab key={t.to} label={t.label} icon={t.icon} active={!more && isActive(path, t.to)} badge={t.badge} onClick={() => { setMore(false); navigate(t.to) }} />)}
        <Tab label="More" icon={EllipsisHorizontalIcon} active={more} aria-expanded={more} onClick={() => setMore(!more)} />
      </nav>
    </>
  )
}

const Customize = createContext<{ editing: boolean; setEditing: (v: boolean) => void; register: (on: boolean) => void }>({ editing: false, setEditing() {}, register() {} })
export const useCustomize = () => useContext(Customize)

function RefreshControl({ onRefresh }: { onRefresh?: () => void }) {
  const ms = useRefresh()
  return (
    <div className="flex h-9 max-sm:h-11 items-stretch overflow-hidden rounded-control border border-line2 bg-surface">
      <button aria-label="Refresh now" className="flex w-11 items-center justify-center border-r border-line2 text-fg2 hover:text-fg" onClick={onRefresh}><ArrowPathIcon className="size-5" aria-hidden /></button>
      <div className="relative flex items-center">
        <select aria-label="Auto-refresh interval" value={ms} onChange={(e) => setRefresh(Number(e.target.value))} className="h-full appearance-none bg-transparent pl-3 pr-7 text-[13px] text-fg2">
          {REFRESH.map(([v, l]) => <option key={v} value={v} className="bg-surface">{l}</option>)}
        </select>
        <ChevronUpDownIcon className="pointer-events-none absolute right-1.5 size-4 text-fg3" aria-hidden />
      </div>
    </div>
  )
}

export function PageHeader({ title, crumbs, subtitle, actions, variables, onRefresh }: { title: string; crumbs?: { label: string; to?: string }[]; subtitle?: ReactNode; actions?: ReactNode; variables?: ReactNode; onRefresh?: () => void }) {
  return (
    <header className="mb-6 border-b border-line pb-6 max-sm:border-0 max-sm:pb-0">
      {crumbs && (
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-2 text-xs text-fg2 max-sm:hidden">
          {crumbs.map((c, i) => (
            <span key={c.label} className="flex items-center gap-2">
              {i > 0 && <ChevronRightIcon className="size-3" aria-hidden />}
              {c.to ? <Link to={c.to} className="hover:text-fg">{c.label}</Link> : c.label}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[26px] leading-[34px] font-medium">{title}</h1>
          {subtitle && <p className="text-[13px] text-fg2">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3 max-sm:w-full">
          {actions}
          {onRefresh && <RefreshControl onRefresh={onRefresh} />}
        </div>
      </div>
      {variables && <div className="mt-3 flex flex-wrap gap-3">{variables}</div>}
    </header>
  )
}

export const Section = ({ children }: { children: ReactNode }) => <div className="flex flex-col gap-4">{children}</div>

async function passkeyLogin(email: string) {
  const { flow, options } = await api("/api/auth/passkey/login/start", { body: { email } })
  const publicKey = (PublicKeyCredential as any).parseRequestOptionsFromJSON(options.publicKey)
  const cred = (await navigator.credentials.get({ publicKey })) as any
  await api("/api/auth/passkey/login/finish", { body: { flow, credential: cred.toJSON() } })
}

function Gate({ setup, passkeys, onDone, name }: { setup: boolean; passkeys: boolean; onDone: () => void; name: string }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const run = async (f: () => Promise<unknown>) => {
    setError("")
    try { await f(); onDone() } catch (e) { setError((e as Error).message) }
  }
  return (
    <main className="flex min-h-full items-center justify-center p-5">
      <form className="flex w-full max-w-sm flex-col gap-4 rounded-panel border border-line bg-surface p-6" onSubmit={(e) => { e.preventDefault(); run(() => api(setup ? "/api/auth/setup" : "/api/auth/login", { body: { email, password } })) }}>
        <div className="flex items-center gap-3"><Logo /><h1 className="text-lg font-medium">{name}</h1></div>
        <p className="text-fg2">{setup ? "Create the administrator account." : "Sign in to continue."}</p>
        <Input label="Email" type="email" autoComplete="username webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label="Password" type="password" autoComplete={setup ? "new-password" : "current-password"} required minLength={setup ? 10 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} hint={setup ? "At least 10 characters." : undefined} />
        <ErrorNote>{error}</ErrorNote>
        <Button variant="primary" type="submit">{setup ? "Create account" : "Sign in"}</Button>
        {!setup && passkeys && <Button onClick={() => run(() => passkeyLogin(email))} disabled={!email}>Use a passkey</Button>}
      </form>
    </main>
  )
}

/** First start: where this server keeps its data. It restarts on the chosen database. */
function DatabaseChoice({ name, embedded, onDone }: { name: string; embedded: boolean; onDone: () => void }) {
  const [mode, setMode] = useState(embedded ? "local" : "remote")
  const [url, setUrl] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setError("")
    setBusy(true)
    try {
      await api("/api/database", { body: mode === "local" ? { mode } : { mode, url, email, password } })
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if (await api("/api/auth/status").then((s) => !s.database_setup, () => false)) return onDone()
      }
      setError("The server did not come back. Check its logs.")
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }
  return (
    <main className="flex min-h-full items-center justify-center p-5">
      <form className="flex w-full max-w-sm flex-col gap-4 rounded-panel border border-line bg-surface p-6" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div className="flex items-center gap-3"><Logo /><h1 className="text-lg font-medium">{name}</h1></div>
        <p className="text-fg2">Where should {name} keep its data?</p>
        {embedded && <Tabs tabs={[{ id: "local", label: "Local" }, { id: "remote", label: "Remote" }]} value={mode} onChange={setMode} />}
        {mode === "local"
          ? <p className="text-fg2">On this server, with its own accounts. Nothing else to install.</p>
          : <>
              <p className="text-fg2">On a nyx-db server. The monitor and the manager share the same accounts when both connect to it.</p>
              <Input label="Database URL" type="url" required placeholder="https://db.example.com" value={url} onChange={(e) => setUrl(e.target.value)} hint="Plain HTTP only works on a private network." />
              <Input label="Email" type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <Input label="Password" type="password" autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </>}
        <ErrorNote>{error}</ErrorNote>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? "Starting…" : "Continue"}</Button>
      </form>
    </main>
  )
}

function OfflineNote() {
  return useOnline() ? null : (
    <p role="status" className="mb-4 rounded-panel border border-line2 bg-off-soft px-4 py-2.5 text-fg2">You are offline. Figures below are from your last connection.</p>
  )
}

function Authed({ useNav, route, customizable }: { useNav: () => NavConfig; route: (path: string) => ReactNode; customizable?: boolean }) {
  const nav = useNav()
  const path = usePath()
  const [editing, setEditing] = useState(false)
  const [canCustomize, register] = useState(false)
  return (
    <Customize.Provider value={{ editing, setEditing, register }}>
      <Sidebar nav={nav} path={path} />
      <header className="sticky top-0 z-10 flex h-[calc(56px+env(safe-area-inset-top))] items-end justify-between border-b border-line bg-sidebar px-4 pt-[env(safe-area-inset-top)] sm:hidden">
        <Link to="/" className="flex h-14 items-center gap-3"><Logo className="size-7" /><span className="text-base font-medium">{nav.name}</span></Link>
        <Link to="/search" aria-label="Search" className="flex size-14 items-center justify-center text-fg2"><MagnifyingGlassIcon className="size-5" aria-hidden /></Link>
      </header>
      <main className="pb-16 pl-[248px] max-lg:pl-[72px] max-sm:pb-[calc(96px+env(safe-area-inset-bottom))] max-sm:pl-0">
        <div className="px-6 pt-5 max-sm:px-4 max-sm:pt-4"><OfflineNote />{route(path)}</div>
      </main>
      <BottomBar nav={nav} path={path} onCustomize={customizable && canCustomize ? () => setEditing(true) : undefined} />
    </Customize.Provider>
  )
}

/** Authentication gate, then navigation and the page for the current path. */
export function App({ name, useNav, route, customizable }: { name: string; useNav: () => NavConfig; route: (path: string) => ReactNode; customizable?: boolean }) {
  const { data: status, reload, error } = useApi("/api/auth/status", { poll: false })
  useEffect(() => {
    document.title = name
    addEventListener(AUTH_LOST, reload)
    return () => removeEventListener(AUTH_LOST, reload)
  }, [name, reload])
  if (!status) return error ? <main className="flex min-h-full items-center justify-center p-5"><div className="flex flex-col items-center gap-4 text-fg2"><Logo /><p>Cannot reach {name}.</p><Button onClick={reload}>Try again</Button></div></main> : null
  if (status.database_setup) return <DatabaseChoice name={name} embedded={status.embedded} onDone={reload} />
  if (!status.authenticated) return <Gate setup={status.needs_setup} passkeys={status.passkeys} onDone={reload} name={name} />
  return <Authed useNav={useNav} route={route} customizable={customizable} />
}

/** Render the app and install the service worker (HTTPS or localhost only). */
export function mount(app: ReactNode) {
  createRoot(document.getElementById("root")!).render(app)
  if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})
}
