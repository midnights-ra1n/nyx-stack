import { useState } from "react"
import { Button, Input, Select, TextArea, ask, tell } from "../ui/components"

type RepoFile = { path: string; content: string }
type Send = (body: any, msg: string) => void

const NEW = "new"

/** A Debian archive (`…/debian`) or security (`…/debian-security`) source. The main
 * component keeps out third-party repositories that also live under `/debian`, such as Docker's. */
// shortcut: a third-party repository with a `/debian` path and a `main` component reads as Debian, the confirm lists what changes.
function debianKind(uri: string, comps: string[]): "archive" | "security" | null {
  if (!comps.includes("main")) return null
  const m = uri.match(/^https?:\/\/[^/\s]+(?:\/\S*)?\/debian(-security)?\/?$/)
  return m ? (m[1] ? "security" : "archive") : null
}

/** Each source of a file: one-line `deb` lines, or deb822 stanzas in a `.sources` file. */
function rewrite(f: RepoFile, swap: (uri: string, comps: string[]) => string): string {
  if (f.path.endsWith(".sources")) {
    return f.content.split(/(\n[ \t]*\n)/).map((stanza) => {
      const comps = stanza.match(/^Components:[ \t]*(.*)$/im)?.[1].trim().split(/\s+/) ?? []
      return stanza.replace(/^(URIs:[ \t]*)(.*)$/im, (_, key, uris: string) => key + uris.trim().split(/\s+/).map((u) => swap(u, comps)).join(" "))
    }).join("")
  }
  return f.content.split("\n").map((line) => {
    const m = line.match(/^(\s*deb(?:-src)?\s+(?:\[[^\]]*\]\s+)?)(\S+)(\s+\S+\s+)(.*)$/)
    return m ? m[1] + swap(m[2], m[4].trim().split(/\s+/)) + m[3] + m[4] : line
  }).join("\n")
}

/** The Debian mirror in use, as `host/path` and its scheme. */
export function currentMirror(files: RepoFile[]): { mirror: string; scheme: string } | null {
  for (const f of files) {
    let found: string | null = null
    rewrite(f, (uri, comps) => { if (!found && debianKind(uri, comps) === "archive") found = uri; return uri })
    if (found) {
      const [, scheme, mirror] = (found as string).match(/^(https?):\/\/(.*?)\/?$/)!
      return { mirror, scheme }
    }
  }
  return null
}

/** The files that change when Debian moves to `mirror` over `scheme`. Security sources
 * keep their server, as few mirrors carry them, and only take the scheme. */
export function setMirror(files: RepoFile[], mirror: string, scheme: string): RepoFile[] {
  const target = mirror.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")
  const swap = (uri: string, comps: string[]) => {
    const kind = debianKind(uri, comps)
    return kind === "archive" ? `${scheme}://${target}` : kind === "security" ? uri.replace(/^https?/, scheme) : uri
  }
  return files.map((f) => ({ ...f, content: rewrite(f, swap) })).filter((f, i) => f.content !== files[i].content)
}

export function ReposPanel({ files, send }: { files: RepoFile[]; send: Send }) {
  const current = currentMirror(files)
  const [mirror, setMirrorText] = useState(current?.mirror ?? "")
  const [scheme, setScheme] = useState(current?.scheme ?? "https")
  const [path, setPath] = useState(files[0]?.path ?? NEW)
  const [name, setName] = useState("")
  const file = files.find((f) => f.path === path)
  const [text, setText] = useState(file?.content ?? "")
  const dir = files.some((f) => f.path.startsWith("/etc/yum.repos.d/")) ? "/etc/yum.repos.d/" : "/etc/apt/sources.list.d/"
  const pick = (p: string) => { setPath(p); setText(files.find((f) => f.path === p)?.content ?? "") }

  const applyMirror = async () => {
    const changed = setMirror(files, mirror, scheme)
    if (!changed.length) return await tell("The Debian sources already use this mirror and protocol.")
    if (await ask(`Point Debian to ${scheme}://${mirror.trim()} in:\n${changed.map((f) => f.path).join("\n")}`, { action: "Change mirror" })) send({ action: "repos", files: changed }, "Mirror change requested.")
  }
  const save = () => {
    const target = path === NEW ? dir + name.trim() : path
    send({ action: "repos", files: [{ path: target, content: text.endsWith("\n") || !text ? text : text + "\n" }] }, "Sources saved.")
  }

  return (
    <div className="flex flex-col gap-6">
      {current && (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); applyMirror() }}>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Input label="Debian mirror" value={mirror} onChange={(e) => setMirrorText(e.target.value)} placeholder="deb.debian.org/debian" hint="Server and path, such as ftp.fr.debian.org/debian. Security sources keep their server and take the protocol." />
            <Select label="Protocol" value={scheme} onChange={(e) => setScheme(e.target.value)} options={[{ value: "https", label: "HTTPS" }, { value: "http", label: "HTTP" }]} />
          </div>
          <div><Button type="submit" disabled={!mirror.trim()}>Apply to Debian sources</Button></div>
        </form>
      )}
      <div className="flex flex-col gap-3">
        <Select label="Source file" value={path} onChange={(e) => pick(e.target.value)} options={[...files.map((f) => f.path), { value: NEW, label: "New file…" }]} />
        {path === NEW && <Input label="File name" value={name} onChange={(e) => setName(e.target.value)} placeholder={dir.includes("yum") ? "example.repo" : "example.list or example.sources"} hint={`Created in ${dir}. A signing key it names must already be on the host.`} />}
        <TextArea label="Content" value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false} hint="Saved, then the package index is refreshed. If the refresh fails, every file is put back as it was." />
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={save} disabled={!text.trim() || (path === NEW && !name.trim()) || text === file?.content}>Save</Button>
          {file && <Button variant="danger" onClick={async () => { if (await ask(`Delete ${file.path}?`, { action: "Delete", danger: true })) send({ action: "repos", files: [{ path: file.path, content: "" }] }, "Deletion requested.") }}>Delete file</Button>}
        </div>
      </div>
    </div>
  )
}
