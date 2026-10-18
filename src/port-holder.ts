// Who holds a local TCP port, for the error when a connection-file port
// stays taken past the startup retry (#257). Linux only: it reads
// /proc/net/tcp{,6} and matches socket inodes against /proc/<pid>/fd.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

const STATES: Record<string, string> = {
  "01": "ESTABLISHED",
  "02": "SYN_SENT",
  "03": "SYN_RECV",
  "04": "FIN_WAIT1",
  "05": "FIN_WAIT2",
  "06": "TIME_WAIT",
  "07": "CLOSE",
  "08": "CLOSE_WAIT",
  "09": "LAST_ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
};

export interface PortSocket {
  /** The remote end as hex `address:port`, as /proc prints it. */
  remote: string;
  state: string;
  inode: string;
}

/** The sockets in a /proc/net/tcp table whose local port is `port`. */
export function socketsOnPort(table: string, port: number): PortSocket[] {
  const found: PortSocket[] = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [, local, remote, state] = fields;
    if (parseInt(local.slice(local.lastIndexOf(":") + 1), 16) !== port) continue;
    found.push({ remote, state: STATES[state] ?? state, inode: fields[9] });
  }
  return found;
}

function describePid(pid: string): string {
  let cmdline = "?";
  let ppid = "?";
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    // Exited since.
  }
  try {
    // The command name in parentheses may hold spaces; ppid is the second field after it.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    ppid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
  } catch {
    // Exited since.
  }
  return `pid ${pid} (ppid ${ppid}): ${cmdline}`;
}

/**
 * One line per socket on `port`: its state, remote end and owning process,
 * or an empty list when it can't be told (not Linux, or nothing found).
 */
export function portHolders(port: number): string[] {
  const sockets: PortSocket[] = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      sockets.push(...socketsOnPort(readFileSync(table, "utf8"), port));
    } catch {
      // No /proc, or no IPv6.
    }
  }
  if (sockets.length === 0) return [];
  const owners = new Map<string, string[]>();
  const wanted = new Set(sockets.map((s) => `socket:[${s.inode}]`));
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    // Leave owners unknown.
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // Another user's, or exited.
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!wanted.has(link)) continue;
      const list = owners.get(link) ?? [];
      if (!list.includes(pid)) list.push(pid);
      owners.set(link, list);
    }
  }
  return sockets.map((s) => {
    const pidsOf = owners.get(`socket:[${s.inode}]`) ?? [];
    const who = pidsOf.length > 0 ? pidsOf.map(describePid).join("; ") : s.inode === "0" ? "no process" : "owner not visible";
    return `${s.state} to ${s.remote}, ${who}`;
  });
}
